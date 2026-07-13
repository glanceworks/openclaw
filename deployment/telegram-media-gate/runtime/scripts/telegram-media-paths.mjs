import path from 'path';

const DEFAULT_TELEGRAM_MEDIA_DATA_ROOT = '/home/node/.openclaw/workspace-coordinator';

function resolveOptionalAbsoluteEnvPath(envName) {
  const raw = process.env[envName];
  if (raw === undefined) return '';
  const value = raw.trim();
  if (!value) return '';
  if (!path.isAbsolute(value)) {
    throw new Error(`${envName} must be an absolute path when set.`);
  }
  return value;
}

function resolveTelegramMediaDataRoot() {
  const raw = process.env.OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT;
  if (raw === undefined) return DEFAULT_TELEGRAM_MEDIA_DATA_ROOT;
  const root = raw.trim();
  if (!root) {
    throw new Error('OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT is set but empty.');
  }
  if (!path.isAbsolute(root)) {
    throw new Error('OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT must be an absolute path when set.');
  }
  return root;
}

function joinUnderTelegramMediaDataRoot(...parts) {
  return path.join(resolveTelegramMediaDataRoot(), ...parts);
}

function getTelegramMediaAccessConfigPath() {
  return joinUnderTelegramMediaDataRoot('config', 'telegram-media-access.json');
}

function getMediaRequestMvpConfigPath() {
  return joinUnderTelegramMediaDataRoot('config', 'media-request-mvp.json');
}

function getTelegramMediaEnrollmentStatePath() {
  return resolveOptionalAbsoluteEnvPath('TELEGRAM_MEDIA_ENROLLMENT_STATE_PATH')
    || joinUnderTelegramMediaDataRoot('state', 'telegram-media-enrollment-runtime.json');
}

function getTelegramMediaEnrollmentAuditLogPath() {
  return resolveOptionalAbsoluteEnvPath('TELEGRAM_MEDIA_ENROLLMENT_LOG_PATH')
    || joinUnderTelegramMediaDataRoot('logs', 'telegram-media-enrollment-audit.jsonl');
}

function getTelegramMediaRuntimeStatePath() {
  return resolveOptionalAbsoluteEnvPath('TELEGRAM_MEDIA_RUNTIME_STATE_PATH')
    || joinUnderTelegramMediaDataRoot('state', 'telegram-media-runtime.json');
}

function getTelegramMediaRequestsLogPath() {
  return resolveOptionalAbsoluteEnvPath('TELEGRAM_MEDIA_RUNTIME_LOG_PATH')
    || joinUnderTelegramMediaDataRoot('logs', 'telegram-media-requests.jsonl');
}

export {
  DEFAULT_TELEGRAM_MEDIA_DATA_ROOT,
  getMediaRequestMvpConfigPath,
  getTelegramMediaAccessConfigPath,
  getTelegramMediaEnrollmentAuditLogPath,
  getTelegramMediaEnrollmentStatePath,
  getTelegramMediaRequestsLogPath,
  getTelegramMediaRuntimeStatePath,
  joinUnderTelegramMediaDataRoot,
  resolveTelegramMediaDataRoot
};
