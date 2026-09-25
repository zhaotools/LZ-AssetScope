import { MEMBER_CONFIG } from "./member-config.js?v=0.9.0";

export { MEMBER_CONFIG };

export class MemberAuthError extends Error {
  constructor(message, code = "member_auth_error") {
    super(message);
    this.name = "MemberAuthError";
    this.code = code;
  }
}

function sessionStorage() {
  return window.localStorage;
}

function requireMemberConfig() {
  if (!MEMBER_CONFIG.supabaseUrl || !MEMBER_CONFIG.publishableKey) {
    throw new MemberAuthError("AssetScope 会员服务尚未完成独立配置", "member_not_configured");
  }
}

function authHeaders(accessToken = "") {
  return {
    apikey: MEMBER_CONFIG.publishableKey,
    "Content-Type": "application/json",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function readResponse(response) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body?.msg || body?.message || body?.error_description || body?.error || `HTTP ${response.status}`;
    throw new MemberAuthError(message, body?.error_code || body?.code || `http_${response.status}`);
  }
  return body;
}

function normalizeSession(payload, previousRefreshToken = "") {
  if (!payload?.access_token || !payload?.user?.id) {
    throw new MemberAuthError("登录会话无效", "invalid_session");
  }
  const expiresAt = Number(payload.expires_at)
    || Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || previousRefreshToken,
    expiresAt,
    user: { id: payload.user.id, email: payload.user.email || "" },
  };
}

function saveSession(session) {
  sessionStorage().setItem(MEMBER_CONFIG.storageKey, JSON.stringify(session));
}

function readStoredSession() {
  try {
    const value = JSON.parse(sessionStorage().getItem(MEMBER_CONFIG.storageKey) || "null");
    return value?.accessToken && value?.refreshToken && value?.user?.id ? value : null;
  } catch {
    return null;
  }
}

export function clearMemberSession() {
  sessionStorage().removeItem(MEMBER_CONFIG.storageKey);
}

async function refreshMemberSession(session) {
  requireMemberConfig();
  const response = await fetch(`${MEMBER_CONFIG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: authHeaders(),
    credentials: "omit",
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  const refreshed = normalizeSession(await readResponse(response), session.refreshToken);
  saveSession(refreshed);
  return refreshed;
}

async function currentSession() {
  const stored = readStoredSession();
  if (!stored) return null;
  const expiresSoon = Number(stored.expiresAt) * 1000 <= Date.now() + 60_000;
  return expiresSoon ? refreshMemberSession(stored) : stored;
}

async function fetchMemberProfile(session) {
  requireMemberConfig();
  const query = new URLSearchParams({
    select: "user_id,display_name,role,status,expires_at",
    user_id: `eq.${session.user.id}`,
    limit: "1",
  });
  const response = await fetch(`${MEMBER_CONFIG.supabaseUrl}/rest/v1/member_profiles?${query}`, {
    headers: authHeaders(session.accessToken),
    credentials: "omit",
    cache: "no-store",
  });
  const rows = await readResponse(response);
  if (!Array.isArray(rows) || !rows[0]) {
    throw new MemberAuthError("没有找到有效会员资料", "profile_not_found");
  }
  return rows[0];
}

export function isProfileActive(profile, now = new Date()) {
  if (!profile || profile.status !== "active") return false;
  if (profile.role === "admin") return true;
  return Boolean(profile.expires_at && new Date(profile.expires_at).getTime() > now.getTime());
}

export async function restoreMemberSession() {
  if (!MEMBER_CONFIG.supabaseUrl || !MEMBER_CONFIG.publishableKey) return null;
  try {
    const session = await currentSession();
    if (!session) return null;
    const profile = await fetchMemberProfile(session);
    if (!isProfileActive(profile)) {
      clearMemberSession();
      return null;
    }
    return profile;
  } catch {
    clearMemberSession();
    return null;
  }
}

export async function signInMember(email, password, captchaToken) {
  requireMemberConfig();
  const response = await fetch(`${MEMBER_CONFIG.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: authHeaders(),
    credentials: "omit",
    body: JSON.stringify({
      email: String(email || "").trim(),
      password,
      ...(captchaToken && captchaToken !== "not-required"
        ? { gotrue_meta_security: { captcha_token: captchaToken } }
        : {}),
    }),
  });
  const session = normalizeSession(await readResponse(response));
  const profile = await fetchMemberProfile(session);
  if (!isProfileActive(profile)) {
    throw new MemberAuthError("会员账号尚未激活、已暂停或已到期", "inactive_profile");
  }
  saveSession(session);
  return profile;
}

export async function loadMemberAssetResource(assetId, resource) {
  requireMemberConfig();
  const session = await currentSession();
  if (!session) throw new MemberAuthError("会员登录已失效", "session_expired");
  const query = new URLSearchParams({
    select: "payload",
    asset_id: `eq.${assetId}`,
    resource: `eq.${resource}`,
    limit: "1",
  });
  const response = await fetch(`${MEMBER_CONFIG.supabaseUrl}/rest/v1/asset_snapshots?${query}`, {
    headers: authHeaders(session.accessToken),
    credentials: "omit",
    cache: "no-store",
  });
  const rows = await readResponse(response);
  if (!Array.isArray(rows) || !rows[0]?.payload) {
    throw new MemberAuthError("会员资产数据暂时不可用", "member_data_unavailable");
  }
  return rows[0].payload;
}

export async function signOutMember() {
  const session = readStoredSession();
  try {
    if (session?.accessToken) {
      await fetch(`${MEMBER_CONFIG.supabaseUrl}/auth/v1/logout?scope=local`, {
        method: "POST",
        headers: authHeaders(session.accessToken),
        credentials: "omit",
      });
    }
  } finally {
    clearMemberSession();
  }
}

export function memberErrorMessage(error) {
  if (error?.code === "member_not_configured") return "AssetScope 会员服务尚未完成独立配置。";
  if (error?.code === "inactive_profile" || error?.code === "profile_not_found") {
    return "会员账号尚未激活、已暂停或已到期，请联系管理员。";
  }
  if (error?.code === "captcha_failed") return "安全验证已失效，请重新验证。";
  return "邮箱、密码或安全验证错误，请重新输入。";
}
