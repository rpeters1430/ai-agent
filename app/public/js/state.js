// App state that several modules assign to. (ES module imports are read-only, so these live on one shared object.)
export const state = {
  sessionsTimer: null, // was in auth.js
  openUrlsTimer: null, // was in auth.js
  active: null, // was in workspace.js
  pullTimer: null, // was in ollama.js
  testTimer: null, // was in ollama.js
  labMode: 'coding', // was in ollama.js
  labSelected: null, // was in ollama.js
  ghRepos: [], // was in workspace.js
};
