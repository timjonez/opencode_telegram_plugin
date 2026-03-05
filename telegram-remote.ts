import type { Plugin } from "@opencode-ai/plugin"
import TelegramBot from "node-telegram-bot-api"
import * as fs from "fs"
import * as path from "path"

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

// Setup logging to file
const LOG_FILE = path.join(process.env.HOME || "/tmp", ".opencode-telegram-remote.log")
function log(...args: any[]) {
  const timestamp = new Date().toISOString()
  const message = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")
  const line = `[${timestamp}] [telegram-remote] ${message}\n`
  fs.appendFileSync(LOG_FILE, line)
}

interface PendingPermission {
  permissionId: string
  sessionId: string
  description: string
}

interface OpenCodeCommand {
  name: string
  description: string
}

export const TelegramRemotePlugin: Plugin = async ({
  client,
  $,
  directory,
}) => {
  log("=".repeat(80))
  log(`[telegram-remote] Plugin loading... Log file: ${LOG_FILE}`)
  log(`[telegram-remote] Directory: ${directory}`)
  
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log("[telegram-remote] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID. Plugin disabled.")
    return {}
  }
  
  log("[telegram-remote] Plugin enabled with valid config")

  const chatId = TELEGRAM_CHAT_ID

  // Track state
  let bot: TelegramBot | null = null
  let currentSessionId: string | null = null
  const pendingPermissions = new Map<number, PendingPermission>()
  let isProcessing = false
  let awaitingPromptResult = false  // true when we've fired promptAsync and are waiting for idle
  let openCodeCommands: OpenCodeCommand[] = []
  let eventStreamAbort: AbortController | null = null

  // ---------- Helpers ----------

  async function send(
    text: string,
    options?: TelegramBot.SendMessageOptions,
  ): Promise<TelegramBot.Message | undefined> {
    if (!bot) return undefined
    try {
      return await bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        ...options,
      })
    } catch {
      try {
        return await bot!.sendMessage(
          chatId,
          text.replace(/[_*`\[\]]/g, ""),
          options,
        )
      } catch (err) {
        log("ERROR:", "[telegram-remote] Failed to send message:", err)
      }
    }
  }

  function escMd(text: string): string {
    return text.replace(/[_*`\[\]]/g, "\\$&")
  }

  function truncate(text: string, maxLen = 3000): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen) + "\n... (truncated)"
  }

  function splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text]
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining)
        break
      }
      let splitIdx = remaining.lastIndexOf("\n", maxLen)
      if (splitIdx < maxLen * 0.5) splitIdx = maxLen
      chunks.push(remaining.slice(0, splitIdx))
      remaining = remaining.slice(splitIdx)
    }
    return chunks
  }

  function extractResponseText(data: any): string {
    const parts = data?.parts || []
    return parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.content || p.text || "")
      .filter(Boolean)
      .join("\n")
  }

  // ---------- Get or create session ----------

  async function ensureSession(): Promise<string> {
    if (currentSessionId) {
      try {
        const session = await client.session.get({
          path: { id: currentSessionId },
        })
        if (session.data) {
          log(`[telegram-remote] Using existing session: ${currentSessionId}`)
          return currentSessionId
        }
      } catch {
        // Session gone, create new one
        log(`[telegram-remote] Session ${currentSessionId} not found, creating new one`)
      }
    }
    const session = await client.session.create({
      body: { title: "Telegram Remote" },
    })
    currentSessionId = session.data!.id
    log(`[telegram-remote] Created new session: ${currentSessionId}`)
    return currentSessionId
  }

  // ---------- Fetch OpenCode commands from server ----------

  async function fetchOpenCodeCommands(): Promise<OpenCodeCommand[]> {
    try {
      const result =
        (await (client as any).command?.list?.()) ??
        (await (client as any).GET?.("/command"))
      const cmds = result?.data || result?.body || []
      if (Array.isArray(cmds)) {
        return cmds.map((c: any) => ({
          name: c.name || c.id || "",
          description: c.description || "",
        }))
      }
    } catch (err) {
      log("ERROR:", "[telegram-remote] Failed to fetch commands:", err)
    }
    return []
  }

  // ---------- Execute an OpenCode slash command ----------

  async function executeOpenCodeCommand(
    command: string,
    args: string,
  ): Promise<string> {
    const sessionId = await ensureSession()
    try {
      const result = await client.session.command({
        path: { id: sessionId },
        body: { command, arguments: args },
      })
      const text = extractResponseText(result.data)
      return text || "Command executed."
    } catch (err: any) {
      return `Error: ${err?.message || err}`
    }
  }

  // ---------- Handle session idle (prompt completed) ----------

  async function handleSessionIdle(sessionId: string) {
    if (!awaitingPromptResult) return
    if (sessionId !== currentSessionId) return

    awaitingPromptResult = false
    isProcessing = false
    log(`[telegram-remote] Session idle, fetching last assistant message`)

    try {
      const result = await client.session.messages({ path: { id: sessionId } })
      const messages = (result.data as any[]) || []
      // Find the last assistant message
      const lastAssistant = [...messages].reverse().find(
        (m: any) => m.info?.role === "assistant"
      )
      if (lastAssistant) {
        const responseText = extractResponseText(lastAssistant)
        if (responseText) {
          for (const chunk of splitMessage(responseText, 3500)) await send(chunk)
          return
        }
      }
      await send("Task completed.")
    } catch (err: any) {
      log(`[telegram-remote] Error fetching messages after idle: ${err?.message || err}`)
      await send("Task completed (could not fetch response).")
    }
  }

  // ---------- Respond to permission via SDK ----------

  async function respondToPermission(
    sessionId: string,
    permissionId: string,
    reply: "once" | "always" | "reject",
  ) {
    const label =
      reply === "once" ? "Approved (once)" :
      reply === "always" ? "Approved (always)" :
      "Denied"

    // Call the SDK method directly on the client to preserve `this` binding.
    // The method is postSessionIdPermissionsPermissionId on the OpencodeClient class.
    // Extracting it into a variable loses `this._client` context.
    try {
      await (client as any).postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response: reply },
      })
      log(`[telegram-remote] Permission responded via SDK: ${reply}`)
      await send(`✅ ${label}`)
      return
    } catch (e: any) {
      log(`[telegram-remote] SDK permission response failed: ${e?.message || e}`)
    }

    // Fallback: try v2 permission.reply() if SDK is upgraded in the future
    try {
      const permClient = (client as any).permission
      if (permClient?.reply && typeof permClient.reply === "function") {
        await permClient.reply({ requestID: permissionId, reply })
        log(`[telegram-remote] Permission responded via permission.reply(): ${reply}`)
        await send(`✅ ${label}`)
        return
      }
    } catch (e: any) {
      log(`[telegram-remote] permission.reply() failed: ${e?.message || e}`)
    }

    // All methods failed
    log("[telegram-remote] All permission response methods failed")
    await send(
      `⚠️ Could not respond to permission automatically.\n` +
      `Please respond in the OpenCode TUI directly.`
    )
  }

  // ================================================================
  // Deferred initialization - start bot AFTER plugin returns hooks
  // ================================================================

  // ---------- Handle permission event from any source ----------

  async function handlePermissionAsked(props: any) {
    const sessionId = props.sessionID || props.session_id || props.sessionId
    if (!sessionId || sessionId !== currentSessionId) return

    const tool = props.permission || "unknown"
    const permissionId = props.id || props.permissionID || props.permission_id || props.permissionId
    if (!permissionId) return

    const args = props.patterns
      ? props.patterns.join("\n").slice(0, 400)
      : ""

    // Telegram callback_data has a 64 byte limit, so truncate the
    // permissionId if needed (we look up by it in pendingPermissions)
    const shortId = permissionId.slice(0, 48)
    
    // Send text-based permission request
    const sentMsg = await send(
      `*🔐 Permission Request*\n\n` +
      `Tool: \`${escMd(tool)}\`\n` +
      `Command: \`${escMd(args || "N/A")}\`\n\n` +
      `Reply *YES* to approve once, *ALWAYS* to always allow, or *NO* to deny:`
    )

    if (sentMsg && permissionId) {
      pendingPermissions.set(sentMsg.message_id, {
        permissionId,
        sessionId,
        description: `${tool}: ${args}`,
      })

      // Auto-deny after 5 minutes
      setTimeout(async () => {
        if (pendingPermissions.has(sentMsg.message_id)) {
          pendingPermissions.delete(sentMsg.message_id)
          await send("⏰ Permission timed out (5 min).")
        }
      }, 5 * 60 * 1000)
    }
  }

  // ---------- SSE event stream for real-time events ----------

  async function startEventStream() {
    log("[telegram-remote] Starting SSE event stream...")
    try {
      eventStreamAbort = new AbortController()
      log("[telegram-remote] Subscribing to events...")
      const events = await client.event.subscribe()
      log("[telegram-remote] Event subscription result:", events)
      if (!events.stream) {
        log("ERROR:", "[telegram-remote] No event stream available")
        return
      }

      log("[telegram-remote] Event stream connected, waiting for events...")
      ;(async () => {
        try {
          for await (const event of events.stream as any) {
            log(`[telegram-remote] SSE EVENT RECEIVED: type=${event.type}`, JSON.stringify(event, null, 2))
            try {
              if (event.type === "permission.asked") {
                log("[telegram-remote] Permission event detected, calling handler...")
                await handlePermissionAsked(event.properties || event)
              }
              if (event.type === "session.idle") {
                const props = event.properties || event
                const sessionId =
                  props.sessionID || props.session_id || props.sessionId
                if (sessionId) {
                  log(`[telegram-remote] SSE session.idle for ${sessionId}`)
                  await handleSessionIdle(sessionId)
                }
              }
              if (event.type === "session.error") {
                const props = event.properties || event
                const sessionId =
                  props.sessionID || props.session_id || props.sessionId
                if (sessionId === currentSessionId) {
                  if (awaitingPromptResult) {
                    awaitingPromptResult = false
                    isProcessing = false
                  }
                  await send(
                    `*Session Error:*\n${truncate(String(props.error || "Unknown error"), 1000)}`,
                  )
                }
              }
            } catch (err) {
              log("ERROR:", "[telegram-remote] Error processing event:", err)
            }
          }
        } catch (err: any) {
          if (err?.name !== "AbortError") {
            log("ERROR:", "[telegram-remote] Event stream ended:", err)
            // Reconnect after a delay
            setTimeout(() => startEventStream(), 3000)
          }
        }
      })()
    } catch (err) {
      log("ERROR:", "[telegram-remote] Failed to start event stream:", err)
      // Retry after delay
      setTimeout(() => startEventStream(), 5000)
    }
  }

  async function initBot() {
    log("[telegram-remote] Initializing bot...")
    try {
      // First, kill any stale polling sessions by calling deleteWebhook
      // and consuming pending updates. This prevents the 409 Conflict error.
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`,
      )
      // Small delay to let Telegram release the old polling connection
      await new Promise((r) => setTimeout(r, 1000))

      bot = new TelegramBot(TELEGRAM_BOT_TOKEN!, {
        polling: {
          autoStart: true,
          params: { timeout: 30 },
        },
      })
      log("[telegram-remote] Bot created successfully")

      // Catch polling errors so they don't crash the process
      bot.on("polling_error", (err) => {
        // 409 = another instance was running, we already handled it above
        // but log others
        if (!err.message?.includes("409")) {
          log("ERROR:", "[telegram-remote] Polling error:", err.message)
        }
      })
      bot.on("error", (err) => {
        log("ERROR:", "[telegram-remote] Bot error:", err.message)
      })

      registerCommands()
      registerMessageHandler()
      registerCallbackHandler()

      // Start SSE event stream for real-time permission events
      log("[telegram-remote] Starting event stream...")
      startEventStream().catch((err) => {
        log("ERROR:", "[telegram-remote] Event stream startup failed:", err)
      })

      // Async startup tasks (don't block)
      setupMenuAndNotify().catch((err) => {
        log("ERROR:", "[telegram-remote] Startup notification failed:", err)
      })
    } catch (err) {
      log("ERROR:", "[telegram-remote] Failed to start bot:", err)
    }
  }

  // ================================================================
  // Register all Telegram command handlers
  // ================================================================

  function registerCommands() {
    if (!bot) return

    // --- /start ---
    bot.onText(/\/start/, async () => {
      openCodeCommands = await fetchOpenCodeCommands()

      let helpText =
        `*OpenCode Telegram Remote*\n\n` +
        `Project: \`${escMd(directory)}\`\n\n` +
        `*Session Commands:*\n` +
        `/new - New session (optional title)\n` +
        `/sessions - List recent sessions\n` +
        `/switch - Switch session by ID\n` +
        `/status - Current session info\n` +
        `/pending - Show pending permissions\n` +
        `/abort - Abort running task\n` +
        `/diff - Show file changes\n` +
        `/messages - Show recent messages\n` +
        `/shell - Run a shell command\n` +
        `/commands - List all OpenCode commands\n\n` +
        `*Permission Responses:*\n` +
        `When a permission is requested, reply:\n` +
        `• *YES* or *Y* - Approve once\n` +
        `• *ALWAYS* or *A* - Always allow this pattern\n` +
        `• *NO* or *N* - Deny\n\n` +
        `*OpenCode Commands:*\n` +
        `/oc_undo - Undo last message\n` +
        `/oc_redo - Redo undone message\n` +
        `/oc_compact - Compact/summarize session\n` +
        `/oc_share - Share session\n` +
        `/oc_unshare - Unshare session\n` +
        `/oc_init - Create/update AGENTS.md\n` +
        `/oc_models - List available models\n` +
        `/oc_help - Show OpenCode help\n`

      if (openCodeCommands.length > 0) {
        const builtins = new Set([
          "new", "clear", "undo", "redo", "compact", "summarize",
          "share", "unshare", "init", "models", "themes", "help",
          "exit", "quit", "q", "sessions", "resume", "continue",
          "connect", "details", "editor", "export", "thinking",
        ])
        const custom = openCodeCommands.filter((c) => !builtins.has(c.name))
        if (custom.length > 0) {
          helpText += `\n*Custom Commands:*\n`
          for (const cmd of custom) {
            helpText += `/oc_${cmd.name.replace(/-/g, "_")} - ${escMd(cmd.description || cmd.name)}\n`
          }
        }
      }

      helpText += `\nType any message to send as a prompt.\nPrefix with \`!\` to run a shell command.`
      await send(helpText)
    })

    // --- /new ---
    bot.onText(/\/new(?:\s+(.+))?/, async (msg, match) => {
      const title = match?.[1] || "Telegram Remote"
      try {
        const session = await client.session.create({ body: { title } })
        currentSessionId = session.data!.id
        await send(
          `New session created.\nID: \`${session.data!.id.slice(0, 8)}\`\nTitle: ${escMd(title)}`,
        )
      } catch (err) {
        await send(`Error: ${err}`)
      }
    })

    // --- /sessions ---
    bot.onText(/\/sessions/, async () => {
      try {
        const sessions = await client.session.list()
        if (!sessions.data || sessions.data.length === 0) {
          await send("No sessions found.")
          return
        }
        const list = sessions.data
          .slice(0, 15)
          .map((s: any) => {
            const active = s.id === currentSessionId ? " *(active)*" : ""
            return `\`${s.id.slice(0, 8)}\` - ${escMd(s.title || "Untitled")}${active}`
          })
          .join("\n")
        await send(`*Recent Sessions:*\n\n${list}\n\nUse \`/switch <id>\` to switch.`)
      } catch (err) {
        await send(`Error: ${err}`)
      }
    })

    // --- /switch ---
    bot.onText(/\/switch(?:\s+(.+))?/, async (msg, match) => {
      const targetId = match?.[1]?.trim()
      if (!targetId) {
        await send("Usage: `/switch <session-id-prefix>`")
        return
      }
      try {
        const sessions = await client.session.list()
        const found = sessions.data?.find((s: any) => s.id.startsWith(targetId))
        if (found) {
          currentSessionId = found.id
          await send(`Switched to \`${found.id.slice(0, 8)}\` - ${escMd((found as any).title || "Untitled")}`)
        } else {
          await send(`No session found matching: \`${escMd(targetId)}\``)
        }
      } catch (err) {
        await send(`Error: ${err}`)
      }
    })

    // --- /status ---
    bot.onText(/\/status/, async () => {
      if (!currentSessionId) {
        await send("No active session. Send a message to start one.")
        return
      }
      try {
        const session = await client.session.get({ path: { id: currentSessionId } })
        const s = session.data! as any
        await send(
          `*Session Status*\nID: \`${s.id.slice(0, 8)}\`\nTitle: ${escMd(s.title || "Untitled")}\nProject: \`${escMd(directory)}\``,
        )
      } catch (err) {
        await send(`Error: ${err}`)
      }
    })

    // --- /pending ---
    bot.onText(/\/pending/, async () => {
      if (pendingPermissions.size === 0) {
        await send("No pending permissions.")
        return
      }
      const list = Array.from(pendingPermissions.entries())
        .map(([msgId, p], i) => `${i + 1}. \`${escMd(p.description)}\``)
        .join("\n")
      await send(
        `*Pending Permissions (${pendingPermissions.size}):*\n\n${list}\n\n` +
        `Reply *YES* to approve once, *ALWAYS* to always allow, or *NO* to deny.`
      )
    })

    // --- /abort ---
    bot.onText(/\/abort/, async () => {
      if (!currentSessionId) {
        await send("No active session.")
        return
      }
      try {
        await client.session.abort({ path: { id: currentSessionId } })
        isProcessing = false
        awaitingPromptResult = false
        await send("Session aborted.")
      } catch (err) {
        await send(`Error: ${err}`)
      }
    })

    // --- /diff ---
    bot.onText(/\/diff/, async () => {
      if (!currentSessionId) {
        await send("No active session.")
        return
      }
      try {
        const result = await client.session.diff({ path: { id: currentSessionId } })
        if (!result.data || (result.data as any[]).length === 0) {
          await send("No file changes in this session.")
          return
        }
        const summary = (result.data as any[])
          .map((d: any) => `\`${escMd(d.path || d.file || "unknown")}\``)
          .join("\n")
        await send(`*Changed files:*\n\n${truncate(summary)}`)
      } catch (err) {
        await send(`Error: ${err}`)
      }
    })

    // --- /messages ---
    bot.onText(/\/messages/, async () => {
      if (!currentSessionId) {
        await send("No active session.")
        return
      }
      try {
        const result = await client.session.messages({ path: { id: currentSessionId } })
        if (!result.data || (result.data as any[]).length === 0) {
          await send("No messages in this session.")
          return
        }
        const msgs = (result.data as any[])
          .slice(-5)
          .map((m: any) => {
            const role = m.info?.role || "unknown"
            const textParts = (m.parts || [])
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.content || p.text || "")
              .join(" ")
            return `*${role}:* ${escMd((textParts || "(no text)").slice(0, 150))}`
          })
          .join("\n\n")
        await send(`*Last 5 messages:*\n\n${truncate(msgs)}`)
      } catch (err) {
        await send(`Error: ${err}`)
      }
    })

    // --- /shell ---
    bot.onText(/\/shell(?:\s+(.+))?/, async (msg, match) => {
      const command = match?.[1]?.trim()
      if (!command) {
        await send("Usage: `/shell <command>`\nExample: `/shell git status`")
        return
      }
      try {
        const sessionId = await ensureSession()
        await send(`Running: \`${escMd(command)}\``)
        const result = await client.session.shell({
          path: { id: sessionId },
          body: { agent: "", command },
        })
        const text = extractResponseText(result.data)
        if (text) {
          for (const chunk of splitMessage(text, 3500)) await send(chunk)
        } else {
          await send("Command executed (no output).")
        }
      } catch (err: any) {
        await send(`Error: ${escMd(err?.message || String(err))}`)
      }
    })

    // --- /commands ---
    bot.onText(/\/commands/, async () => {
      openCodeCommands = await fetchOpenCodeCommands()
      if (openCodeCommands.length === 0) {
        await send("No custom commands found. Only built-in commands are available.")
        return
      }
      const list = openCodeCommands
        .map((c) => `/oc_${c.name.replace(/-/g, "_")} - ${escMd(c.description || c.name)}`)
        .join("\n")
      await send(`*All OpenCode Commands:*\n\n${list}`)
    })

    // --- Single catch-all for ALL /oc_* commands ---
    bot.onText(/^\/oc_(\w+)(?:\s+(.*))?$/, async (msg, match) => {
      const cmdName = match?.[1]?.replace(/_/g, "-") || ""
      const cmdArgs = match?.[2]?.trim() || ""

      // Handle commands with special SDK methods
      try {
        switch (cmdName) {
          case "undo": {
            if (!currentSessionId) { await send("No active session."); return }
            await client.session.revert({ path: { id: currentSessionId }, body: { messageID: "" } })
            await send("Undo complete.")
            return
          }
          case "redo": {
            if (!currentSessionId) { await send("No active session."); return }
            await client.session.unrevert({ path: { id: currentSessionId } })
            await send("Redo complete.")
            return
          }
          case "share": {
            if (!currentSessionId) { await send("No active session."); return }
            const shareResult = await client.session.share({ path: { id: currentSessionId } })
            const url = (shareResult.data as any)?.share_url || (shareResult.data as any)?.shareURL || "Shared."
            await send(`Session shared: ${url}`)
            return
          }
          case "unshare": {
            if (!currentSessionId) { await send("No active session."); return }
            await client.session.unshare({ path: { id: currentSessionId } })
            await send("Session unshared.")
            return
          }
          case "models": {
            const modelsResult = await client.config.providers()
            const data = modelsResult.data as any
            if (!data?.providers || data.providers.length === 0) {
              await send("No providers configured.")
              return
            }
            let text = "*Available Models:*\n\n"
            for (const provider of data.providers) {
              const models = provider.models || []
              if (models.length === 0) continue
              text += `*${escMd(provider.name || provider.id || "Unknown")}:*\n`
              for (const model of models.slice(0, 10)) {
                text += `  \`${escMd(model.name || model.id || "unknown")}\`\n`
              }
              text += "\n"
            }
            for (const chunk of splitMessage(truncate(text, 3800), 3500)) await send(chunk)
            return
          }
          default: {
            // All other commands: execute via session.command()
            await send(`Running /${escMd(cmdName)}${cmdArgs ? " " + escMd(cmdArgs) : ""}...`)
            const response = await executeOpenCodeCommand(cmdName, cmdArgs)
            for (const chunk of splitMessage(response, 3500)) await send(chunk)
            return
          }
        }
      } catch (err: any) {
        await send(`Error: ${escMd(err?.message || String(err))}`)
      }
    })
  }

  // ================================================================
  // Register message handler (prompts, permissions, shell)
  // ================================================================

  function registerMessageHandler() {
    if (!bot) return

    bot.on("message", async (msg) => {
      if (!msg.text || msg.text.startsWith("/")) return
      if (msg.chat.id.toString() !== chatId) return

      const text = msg.text.trim()
      const lowerText = text.toLowerCase()

      // --- Permission responses ---
      function parsePermissionReply(text: string): "once" | "always" | "reject" | null {
        if (text === "yes" || text === "y" || text === "approve") return "once"
        if (text === "always" || text === "a" || text === "yes always") return "always"
        if (text === "no" || text === "n" || text === "deny" || text === "reject") return "reject"
        return null
      }

      if (msg.reply_to_message) {
        const pending = pendingPermissions.get(msg.reply_to_message.message_id)
        if (pending) {
          const reply = parsePermissionReply(lowerText)
          if (reply) {
            pendingPermissions.delete(msg.reply_to_message.message_id)
            await respondToPermission(pending.sessionId, pending.permissionId, reply)
            return
          }
        }
      }

      // Inline yes/no/always for most recent permission
      if (pendingPermissions.size > 0) {
        const reply = parsePermissionReply(lowerText)
        if (reply) {
          const entries = Array.from(pendingPermissions.entries())
          const [msgId, pending] = entries[entries.length - 1]
          pendingPermissions.delete(msgId)
          await respondToPermission(pending.sessionId, pending.permissionId, reply)
          return
        }
      }

      // --- Inline shell (! prefix) ---
      if (text.startsWith("!")) {
        const command = text.slice(1).trim()
        if (!command) return
        try {
          const sessionId = await ensureSession()
          await send(`Running: \`${escMd(command)}\``)
          const result = await client.session.shell({
            path: { id: sessionId },
            body: { agent: "", command },
          })
          const responseText = extractResponseText(result.data)
          if (responseText) {
            for (const chunk of splitMessage(responseText, 3500)) await send(chunk)
          } else {
            await send("Command executed (no output).")
          }
        } catch (err: any) {
          await send(`Error: ${escMd(err?.message || String(err))}`)
        }
        return
      }

      // --- Regular prompt ---
      if (isProcessing) {
        await send("OpenCode is still working. Use /abort to cancel.")
        return
      }

      try {
        isProcessing = true
        awaitingPromptResult = true
        const sessionId = await ensureSession()
        log(`[telegram-remote] Sending async prompt to session: ${sessionId}`)
        await send("Working on it...")

        // Use promptAsync (fire-and-forget) so the connection is free for
        // permission responses. The result will be picked up by the
        // session.idle event handler via handleSessionIdle().
        await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text }] },
        })
        log(`[telegram-remote] Async prompt dispatched, waiting for session.idle`)
      } catch (err: any) {
        isProcessing = false
        awaitingPromptResult = false
        await send(`Error: ${escMd(err?.message || String(err))}`)
      }
    })
  }

  // ================================================================
  // Register callback query handler (inline keyboard buttons)
  // ================================================================

  function registerCallbackHandler() {
    if (!bot) return

    bot.on("callback_query", async (query) => {
      if (!query.data || !query.message) return
      if (query.message.chat.id.toString() !== chatId) return

      const data = query.data

      // Handle permission buttons: pa_ = approve once, pA_ = approve always, pd_ = deny
      if (data.startsWith("pa_") || data.startsWith("pA_") || data.startsWith("pd_")) {
        const reply: "once" | "always" | "reject" =
          data.startsWith("pA_") ? "always" :
          data.startsWith("pa_") ? "once" : "reject"
        const permissionId = data.slice(3) // Remove prefix

        // Find the pending permission by permissionId (match by prefix
        // since callback_data may have been truncated)
        let foundMsgId: number | undefined
        let foundPending: PendingPermission | undefined
        for (const [msgId, pending] of pendingPermissions.entries()) {
          if (pending.permissionId.startsWith(permissionId)) {
            foundMsgId = msgId
            foundPending = pending
            break
          }
        }

        const label =
          reply === "once" ? "Approved (once)" :
          reply === "always" ? "Approved (always)" :
          "Denied"

        if (foundPending && foundMsgId !== undefined) {
          pendingPermissions.delete(foundMsgId)
          await respondToPermission(
            foundPending.sessionId,
            foundPending.permissionId,
            reply,
          )

          // Update the message to show the decision
          try {
            await bot!.editMessageText(
              `${query.message.text}\n\n${label}`,
              {
                chat_id: chatId,
                message_id: query.message.message_id,
              },
            )
          } catch {
            // Message may have been deleted or already edited
          }

          // Acknowledge the callback
          await bot!.answerCallbackQuery(query.id, { text: label })
        } else {
          await bot!.answerCallbackQuery(query.id, {
            text: "Permission already handled or expired.",
          })
        }
        return
      }

      // Acknowledge unknown callbacks
      await bot!.answerCallbackQuery(query.id)
    })
  }

  // ================================================================
  // Async startup (register menu + send notification)
  // ================================================================

  async function setupMenuAndNotify() {
    if (!bot) return

    openCodeCommands = await fetchOpenCodeCommands()

    const telegramCommands: TelegramBot.BotCommand[] = [
      { command: "start", description: "Show help and all commands" },
      { command: "new", description: "New session (optional title)" },
      { command: "sessions", description: "List recent sessions" },
      { command: "switch", description: "Switch session by ID" },
      { command: "status", description: "Current session info" },
      { command: "abort", description: "Abort running task" },
      { command: "diff", description: "Show file changes" },
      { command: "messages", description: "Show recent messages" },
      { command: "shell", description: "Run a shell command" },
      { command: "commands", description: "List all OpenCode commands" },
      { command: "oc_undo", description: "Undo last message + file changes" },
      { command: "oc_redo", description: "Redo undone message" },
      { command: "oc_compact", description: "Compact/summarize session" },
      { command: "oc_share", description: "Share session" },
      { command: "oc_unshare", description: "Unshare session" },
      { command: "oc_init", description: "Create/update AGENTS.md" },
      { command: "oc_models", description: "List available models" },
      { command: "oc_help", description: "Show OpenCode help" },
    ]

    const builtinNames = new Set([
      "new", "clear", "undo", "redo", "compact", "summarize",
      "share", "unshare", "init", "models", "themes", "help",
      "exit", "quit", "q", "sessions", "resume", "continue",
      "connect", "details", "editor", "export", "thinking",
    ])

    for (const cmd of openCodeCommands) {
      if (builtinNames.has(cmd.name)) continue
      const tgName = `oc_${cmd.name.replace(/-/g, "_")}`.slice(0, 32)
      const tgDesc = (cmd.description || cmd.name).slice(0, 256)
      telegramCommands.push({ command: tgName, description: tgDesc })
    }

    try {
      await bot.setMyCommands(telegramCommands.slice(0, 100))
    } catch (err) {
      log("ERROR:", "[telegram-remote] Failed to set bot commands:", err)
    }

    await send(
      `OpenCode Remote connected!\nProject: \`${escMd(directory)}\`\nCommands: ${telegramCommands.length}\nDebug logs: \`${escMd(LOG_FILE)}\`\n\nSend /start for help.`,
    )
  }

  // ================================================================
  // Start the bot on next tick so we don't block plugin init
  // ================================================================

  setTimeout(() => initBot(), 0)

  // ================================================================
  // Return plugin event hooks immediately (non-blocking)
  // ================================================================

  return {
    event: async ({ event }: { event: any }) => {
      log(`[telegram-remote] Event: ${event.type}`)
      const props = event.properties || {}

      if (event.type === "permission.asked") {
        log("[telegram-remote] Event hook detected permission.asked event")
        // Use the centralized handler (dedup: skip if already handled via SSE)
        const permissionId =
          props.permissionID || props.permission_id || props.permissionId || props.id
        log(`[telegram-remote] Extracted permissionId: ${permissionId}`)
        const alreadyHandled = Array.from(pendingPermissions.values()).some(
          (p) => p.permissionId === permissionId,
        )
        log(`[telegram-remote] Already handled via SSE: ${alreadyHandled}`)
        if (!alreadyHandled) {
          log("[telegram-remote] Calling handlePermissionAsked from event hook...")
          await handlePermissionAsked(props)
        }
      }

      if (event.type === "session.idle") {
        const sessionId =
          props.sessionID || props.session_id || props.sessionId
        if (sessionId) {
          log(`[telegram-remote] Event hook session.idle for ${sessionId}`)
          // Dedup: only handle if SSE hasn't already handled it
          if (awaitingPromptResult && sessionId === currentSessionId) {
            await handleSessionIdle(sessionId)
          }
        }
      }

      if (event.type === "session.error") {
        const sessionId =
          props.sessionID || props.session_id || props.sessionId
        if (sessionId === currentSessionId) {
          if (awaitingPromptResult) {
            awaitingPromptResult = false
            isProcessing = false
          }
          await send(
            `*Session Error:*\n${truncate(String(props.error || "Unknown error"), 1000)}`,
          )
        }
      }
    },
  }
}
