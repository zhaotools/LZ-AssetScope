import { MEMBER_CONFIG } from "./member-config.js?v=1.0.6";

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
    const responseCode = body?.error_code
      || body?.code
      || (typeof body?.error === "string" && /^[a-z0-9_]+$/.test(body.error) ? body.error : "")
      || `http_${response.status}`;
    throw new MemberAuthError(message, responseCode);
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
    user: {
      id: payload.user.id,
      email: payload.user.email || "",
      userMetadata: payload.user.user_metadata || {},
    },
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
  const profile = rows[0];
  const metadataName = String(session.user.userMetadata?.display_name || "").trim();
  return metadataName ? { ...profile, display_name: metadataName } : profile;
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

export async function loadMemberAssets() {
  requireMemberConfig();
  const session = await currentSession();
  if (!session) throw new MemberAuthError("会员登录已失效", "session_expired");
  const query = new URLSearchParams({
    select: "position,status,created_at,asset:asset_catalog(asset_id,category,provider_symbol,display_symbol,name,exchange,currency,timezone,status,last_error,last_updated_at)",
    order: "position.asc,created_at.asc",
  });
  const response = await fetch(`${MEMBER_CONFIG.supabaseUrl}/rest/v1/member_assets?${query}`, {
    headers: authHeaders(session.accessToken),
    credentials: "omit",
    cache: "no-store",
  });
  const rows = await readResponse(response);
  return Array.isArray(rows) ? rows : [];
}

export async function loadMemberInitializationJobs() {
  requireMemberConfig();
  const session = await currentSession();
  if (!session) throw new MemberAuthError("会员登录已失效", "session_expired");
  const query = new URLSearchParams({
    select: "id,asset_id,status,progress_stage,error_code,error_message,created_at,updated_at",
    order: "created_at.desc",
    limit: "30",
  });
  const response = await fetch(`${MEMBER_CONFIG.supabaseUrl}/rest/v1/asset_initialization_jobs?${query}`, {
    headers: authHeaders(session.accessToken),
    credentials: "omit",
    cache: "no-store",
  });
  const rows = await readResponse(response);
  return Array.isArray(rows) ? rows : [];
}

export async function loadMemberAssetSummaries() {
  requireMemberConfig();
  const session = await currentSession();
  if (!session) throw new MemberAuthError("会员登录已失效", "session_expired");
  const query = new URLSearchParams({
    select: "asset_id,payload",
    resource: "eq.current.json",
    order: "asset_id.asc",
  });
  const response = await fetch(`${MEMBER_CONFIG.supabaseUrl}/rest/v1/asset_snapshots?${query}`, {
    headers: authHeaders(session.accessToken),
    credentials: "omit",
    cache: "no-store",
  });
  const rows = await readResponse(response);
  return Array.isArray(rows) ? rows : [];
}

async function callAssetApi(payload) {
  if (!MEMBER_CONFIG.assetProxyRpc) {
    throw new MemberAuthError("资产初始化服务尚未发布", "asset_api_not_configured");
  }
  const session = await currentSession();
  if (!session) throw new MemberAuthError("会员登录已失效", "session_expired");
  const response = await fetch(`${MEMBER_CONFIG.supabaseUrl}/rest/v1/rpc/${MEMBER_CONFIG.assetProxyRpc}`, {
    method: "POST",
    headers: authHeaders(session.accessToken),
    credentials: "omit",
    body: JSON.stringify({ request_payload: payload }),
  });
  const result = await readResponse(response);
  if (result?.error) throw new MemberAuthError(result.error, result.error);
  return result;
}

export async function resolveMemberAssets(category, query) {
  return callAssetApi({ action: "resolve", category, query });
}

export async function addMemberAsset(candidate) {
  return callAssetApi({ action: "add", candidate });
}

export async function removeMemberAsset(assetId) {
  return callAssetApi({ action: "remove", assetId });
}

async function updateAuthenticatedUser(session, attributes) {
  const response = await fetch(`${MEMBER_CONFIG.supabaseUrl}/auth/v1/user`, {
    method: "PUT",
    headers: authHeaders(session.accessToken),
    credentials: "omit",
    body: JSON.stringify(attributes),
  });
  const user = await readResponse(response);
  session.user = {
    id: user?.id || session.user.id,
    email: user?.email || session.user.email,
    userMetadata: user?.user_metadata || session.user.userMetadata || {},
  };
  saveSession(session);
  return user;
}

export async function updateMemberDisplayName(displayName) {
  requireMemberConfig();
  const name = String(displayName || "").trim();
  if (name.length < 1 || name.length > 30) {
    throw new MemberAuthError("用户名需为 1–30 个字符", "display_name_invalid");
  }
  const session = await currentSession();
  if (!session) throw new MemberAuthError("会员登录已失效", "session_expired");
  await updateAuthenticatedUser(session, { data: { display_name: name } });
  return fetchMemberProfile(session);
}

export async function updateMemberPassword(currentPassword, newPassword, captchaToken = "") {
  requireMemberConfig();
  if (!currentPassword) throw new MemberAuthError("请输入当前密码", "current_password_required");
  if (String(newPassword || "").length < 8) {
    throw new MemberAuthError("新密码至少需要 8 个字符", "weak_password");
  }
  if (currentPassword === newPassword) {
    throw new MemberAuthError("新密码不能与当前密码相同", "same_password");
  }
  const session = await currentSession();
  if (!session?.user?.email) throw new MemberAuthError("会员登录已失效", "session_expired");

  const verifyResponse = await fetch(`${MEMBER_CONFIG.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: authHeaders(),
    credentials: "omit",
    body: JSON.stringify({
      email: session.user.email,
      password: currentPassword,
      ...(captchaToken && captchaToken !== "not-required"
        ? { gotrue_meta_security: { captcha_token: captchaToken } }
        : {}),
    }),
  });
  const verifiedSession = normalizeSession(await readResponse(verifyResponse));
  await updateAuthenticatedUser(verifiedSession, {
    password: newPassword,
    current_password: currentPassword,
  });
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
  if (error?.code === "display_name_invalid") return "用户名需为 1–30 个字符。";
  if (error?.code === "invalid_credentials" || error?.code === "current_password_mismatch") return "当前密码不正确。";
  if (error?.code === "current_password_required") return "请输入当前密码。";
  if (error?.code === "same_password") return "新密码不能与当前密码相同。";
  if (error?.code === "weak_password") return error.message || "新密码强度不足，请使用至少 8 个字符。";
  if (error?.code === "reauthentication_needed") return "登录时间过久，请退出后重新登录再修改密码。";
  if (error?.code === "asset_api_not_configured") return "资产初始化服务尚未发布，请稍后再试。";
  if (error?.code === "asset_limit_reached") return "个人资产已达到 30 个上限，请先移除一个资产。";
  if (error?.code === "market_source_rate_limited") return "行情数据源当前查询繁忙，请稍后重试。";
  if (error?.code === "asset_history_insufficient") return "该资产的有效历史日线不足 260 条，暂时不能初始化。";
  if (error?.code === "asset_category_mismatch") return "资产与所选分类不一致，请重新选择。";
  if (error?.code === "asset_not_found") return "数据源中没有找到该资产。";
  if (error?.code === "market_source_unavailable") return "行情数据源暂时不可用，请稍后重试。";
  if (error?.code === "initialization_dispatch_failed_404") return "初始化工作流尚未发布，请稍后再试。";
  if (String(error?.code || "").startsWith("initialization_dispatch_failed_")) return "初始化任务触发失败，请稍后重试。";
  if (error?.code === "session_expired") return "登录已失效，请重新登录。";
  if (error?.code && error?.code !== "member_auth_error") return error.message || "操作失败，请稍后重试。";
  return "邮箱、密码或安全验证错误，请重新输入。";
}
