import assert from "node:assert/strict";
import test from "node:test";
import { createPrimeApprovalGuardian } from "../extensions/index.ts";

function harness() {
  const handlers = new Map<string, Function>();
  let command: { handler: Function } | undefined;
  const api = {
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerCommand(name: string, value: { handler: Function }) { if (name === "approval-guardian") command = value; },
  };
  return { api, handlers, command: () => command };
}

test("missing optional Prime context methods never skips whole-cell preflight", async () => {
  const h = harness();
  createPrimeApprovalGuardian({ agentDir: "/does/not/exist", review: () => ({ outcome: "deny", reason: "no" }) })(h.api as any);
  const result = await h.handlers.get("tool_call")?.({ toolName: "ipython", toolCallId: "1", input: { code: "print(1)" } }, { cwd: process.cwd() });
  assert.deepEqual(result, { block: true, reason: "no" });
});

test("the shared handler rejects bypass and still protects the next cell in every host mode", async () => {
  // Prime sends every operation mode through this single registered tool_call handler; there is no mode-specific bypass branch.
  const modes = [
    { name: "interactive", hasUI: true },
    { name: "print", hasUI: false },
    { name: "RPC", hasUI: false },
    { name: "daemon", hasUI: false },
  ];
  for (const mode of modes) {
    const h = harness();
    let reviews = 0;
    createPrimeApprovalGuardian({
      agentDir: "/does/not/exist",
      review: () => { reviews++; return { outcome: "deny", reason: "protected" }; },
    })(h.api as any);
    const command = h.command();
    assert.ok(command);
    const notifications: string[] = [];
    await command!.handler("bypass", { cwd: process.cwd(), hasUI: mode.hasUI, ui: { notify(message: string) { notifications.push(message); } } });
    assert.match(notifications.join("\n"), /bypass request rejected/i, mode.name);
    const event = { toolName: "ipython", toolCallId: mode.name, input: { code: "side_effect = true" } };
    const result = await h.handlers.get("tool_call")?.(event, { cwd: process.cwd() });
    assert.deepEqual(result, { block: true, reason: "protected" }, mode.name);
    assert.equal(reviews, 1, `${mode.name} still reviewed the protected cell`);
  }
});


test("reviewer and authentication failures cannot leak hostile error text", async () => {
  const h = harness();
  createPrimeApprovalGuardian({
    agentDir: "/does/not/exist",
    review: () => { throw new Error("AUTH_SECRET\n\u001b[31m/home/alice/project"); },
  })(h.api as any);
  const result = await h.handlers.get("tool_call")?.(
    { toolName: "ipython", toolCallId: "secret", input: { code: "print(1)" } },
    { cwd: process.cwd() },
  );
  assert.deepEqual(result, { block: true, reason: "Prime Approval Guardian review failed; IPython was blocked." });
  assert.doesNotMatch(JSON.stringify(result), /AUTH_SECRET|alice|\u001b/);
});
