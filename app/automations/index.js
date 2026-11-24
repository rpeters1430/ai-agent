'use strict';
// GitHub automations: the installed CLIs fix issues, answer @mentions, review PRs and run scheduled tasks.
// GitHub is polled through the REST API, so the hub never needs to be reachable from the internet.
//
//   store.js     shared state + files      validate.js  settings/rules validation, cron
//   github.js    REST client               prompts.js   agent prompts, review verdicts
//   queue.js     job queue + follow-ups    runner.js    runs one job (worktree → agent → PR/review)
//   polling.js   finds work on GitHub      routes.js    HTTP API, register()
const { register } = require('./routes');
const { cleanRule, cleanWatch, validateCron, matchesCron } = require('./validate');
const { withLock, clipBytes } = require('./store');
const { parseReviewVerdict, buildPrompt } = require('./prompts');
const { buildReviewFollowUp, buildFixFollowUp } = require('./queue');

module.exports = {
  register, cleanRule, cleanWatch, validateCron, matchesCron, withLock, clipBytes,
  parseReviewVerdict, buildPrompt, buildReviewFollowUp, buildFixFollowUp,
};
