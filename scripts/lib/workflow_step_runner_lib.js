const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const my = require('./mysql_lib');
const logger = require('./logger_lib');

const execFileAsync = promisify(execFile);

function lastJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const idx = text.lastIndexOf('\n{');
  try { return JSON.parse(idx >= 0 ? text.slice(idx + 1) : text); } catch (_) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }
}

function stepKeyFromName(name) {
  return String(name || '').replace(/[:]/g, '_');
}

function makeStepRunner({ root = my.ROOT, trace, stepOrderRef }) {
  if (!trace) throw new Error('makeStepRunner requires trace');
  if (!stepOrderRef || typeof stepOrderRef.value !== 'number') throw new Error('makeStepRunner requires stepOrderRef.value');

  return async function runStep(name, script, args = [], engineRunId, { skipped = false } = {}) {
    stepOrderRef.value += 1;
    const stepId = await trace.createWorkflowStep({
      engineRunId,
      stepKey: stepKeyFromName(name),
      stepName: name,
      stepOrder: stepOrderRef.value,
      inputSummary: { args },
    });
    if (skipped) {
      await trace.finishWorkflowStep(stepId, { status: 'skipped' });
      return { name, ok: true, skipped: true, result: null };
    }

    await trace.startWorkflowStep(stepId);
    await trace.logWorkflowEvent({
      engineRunId,
      workflowStepId: stepId,
      eventType: 'step_started',
      level: 'info',
      message: `步骤开始: ${name}`,
    });

    process.stdout.write(`\n=== [engine] ${name} ===\n`);
    logger.log(`[${engineRunId}] 步骤开始: ${name} ${args.join(' ')}`);

    let outcome;
    try {
      const { stdout } = await execFileAsync('node', [path.join(root, 'scripts', script), ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
        env: { ...process.env, ENGINE_RUN_ID: engineRunId, WORKFLOW_STEP_ID: stepId },
      });
      const out = stdout || '';
      process.stdout.write(out.trim().slice(0, 1200) + '\n');
      logger.log(`[${engineRunId}] 步骤输出 ${name}:\n${out.trim().slice(0, 3000)}`);
      outcome = { name, ok: true, result: lastJson(out) };
    } catch (err) {
      const stdout = (err.stdout || '').toString();
      const stderr = (err.stderr || '').toString();
      process.stdout.write((stdout + stderr).trim().slice(0, 1200) + '\n');
      const parsed = lastJson(stdout);
      outcome = {
        name,
        ok: false,
        result: parsed,
        error: (parsed && parsed.error) || stderr.slice(0, 300) || 'unknown error',
      };
      logger.logError(`[${engineRunId}] 步骤失败 ${name}: ${outcome.error}\nstdout: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 1000)}`);
    }

    const hasWarnings = outcome.result && Array.isArray(outcome.result.warnings) && outcome.result.warnings.length > 0;
    await trace.finishWorkflowStep(stepId, {
      status: outcome.ok ? (hasWarnings ? 'warning' : 'success') : 'failed',
      outputSummary: outcome.result ? { ...outcome.result, results: undefined, items: undefined } : null,
      warnings: hasWarnings ? outcome.result.warnings.slice(0, 10) : null,
      errorMessage: outcome.ok ? null : outcome.error,
    });
    await trace.logWorkflowEvent({
      engineRunId,
      workflowStepId: stepId,
      eventType: 'step_completed',
      level: outcome.ok ? 'info' : 'error',
      message: `步骤${outcome.ok ? '完成' : '失败'}: ${name}${outcome.ok ? '' : ` - ${outcome.error}`}`,
    });
    return outcome;
  };
}

module.exports = { lastJson, stepKeyFromName, makeStepRunner };
