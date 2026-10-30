/**
 * Library entry, for `pnpm demo` and tests: the same pieces `main.ts` wires together. The image
 * runs `dist/main.js`.
 */
export { NodeAgent } from './agent';
export { MonitorClient } from './client';
export { loadConfig, type AgentConfig } from './config';
export { DockerClient, type DockerContainer, type DockerEvent } from './docker';
export { jsonLog, silentLog, type Log } from './log';
export { HostReader } from './proc';
export { AGENT_VERSION } from './version';
