export const TERMINAL_ACTIVITY_UI_MARKER = 'data-pi-student-terminal-activity="v1"';

/**
 * Reports concise outcomes of commands the student runs in Paseo's terminal:
 * the command line, exit code, and for failures a short tail of output that the
 * bridge reduces to redacted error lines. Paseo's zsh integration marks command
 * boundaries with OSC 633 (C = output starts, D;<code> = finished) and sets the
 * window title to the command line. Nothing is reported while a command runs,
 * and successful command output is never sent.
 */
export const terminalActivityUiScript = (port: number) => `
<script ${TERMINAL_ACTIVITY_UI_MARKER}>
(() => {
  const endpoint = "http://127.0.0.1:${port}";
  const attached = new WeakSet();
  const workspace = () => {
    const id = location.pathname.split("/workspace/")[1]?.split("/")[0];
    return id && /^wks_[A-Za-z0-9_-]+$/.test(id) ? id : null;
  };
  const report = (workspaceId, body) => fetch(endpoint + "/workspace-events?workspaceId=" + encodeURIComponent(workspaceId), {
    method: "POST", headers: { "Content-Type": "application/json", "X-Pi-Student": "ecosystem" }, body: JSON.stringify(body)
  }).catch(() => {});
  const outputTail = (terminal, marker) => {
    try {
      const buffer = terminal.buffer.active;
      const end = buffer.baseY + buffer.cursorY;
      const start = marker && !marker.isDisposed && marker.line >= 0 ? marker.line : Math.max(0, end - 40);
      const lines = [];
      for (let line = Math.max(start, end - 60); line <= end; line++) lines.push(buffer.getLine(line)?.translateToString(true) ?? "");
      return lines.join("\\n").slice(-3000);
    } catch { return ""; }
  };
  const attach = terminal => {
    if (!terminal?.parser?.registerOscHandler || attached.has(terminal)) return;
    attached.add(terminal);
    let running = null;
    terminal.parser.registerOscHandler(633, data => {
      const [kind, value] = String(data).split(";");
      if (kind === "C") running = { command: "", workspaceId: workspace(), marker: terminal.registerMarker?.(0) };
      else if (kind === "D" && running) {
        const finished = running;
        running = null;
        const exitCode = Number(value);
        const command = finished.command.trim().slice(0, 300);
        if (finished.workspaceId && command && Number.isSafeInteger(exitCode)) {
          report(finished.workspaceId, { type: "terminal.command_finished", command, exitCode, ...(exitCode === 0 ? {} : { summary: outputTail(terminal, finished.marker) }) });
        }
        finished.marker?.dispose?.();
      }
      // Let Paseo's own handlers see the sequence too.
      return false;
    });
    terminal.onTitleChange?.(title => { if (running && !running.command) running.command = String(title || ""); });
  };
  setInterval(() => attach(window.__paseoTerminal), 1000);
})();
</script>`;
