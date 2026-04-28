import type { Context } from 'koa'
import { getCredentials, setCredentials, verifyCredentials, deleteCredentials } from '../services/credentials'
import { getToken } from '../services/auth'

/**
 * GET /api/auth/status
 * Check if username/password login is configured (public).
 */
export async function authStatus(ctx: Context) {
  const cred = await getCredentials()
  ctx.body = {
    hasPasswordLogin: !!cred,
    username: cred?.username || null,
  }
}

/**
 * POST /api/auth/login
 * Authenticate with username/password (public).
 * Returns the static token on success.
 */
export async function login(ctx: Context) {
  const { username, password } = ctx.request.body as { username?: string; password?: string }
  if (!username || !password) {
    ctx.status = 400
    ctx.body = { error: 'Username and password are required' }
    return
  }

  const valid = await verifyCredentials(username, password)
  if (!valid) {
    ctx.status = 401
    ctx.body = { error: 'Invalid username or password' }
    return
  }

  const token = await getToken()
  if (!token) {
    ctx.status = 500
    ctx.body = { error: 'Auth is disabled on this server' }
    return
  }

  ctx.body = { token }
}

/**
 * POST /api/auth/setup
 * Set up username/password (protected).
 */
export async function setupPassword(ctx: Context) {
  const { username, password } = ctx.request.body as { username?: string; password?: string }
  if (!username || !password) {
    ctx.status = 400
    ctx.body = { error: 'Username and password are required' }
    return
  }
  if (username.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }
  if (password.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'Password must be at least 6 characters' }
    return
  }

  await setCredentials(username, password)
  ctx.body = { success: true }
}

/**
 * POST /api/auth/change-password
 * Change password (protected).
 */
export async function changePassword(ctx: Context) {
  const { currentPassword, newPassword } = ctx.request.body as { currentPassword?: string; newPassword?: string }
  if (!currentPassword || !newPassword) {
    ctx.status = 400
    ctx.body = { error: 'Current password and new password are required' }
    return
  }
  if (newPassword.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'New password must be at least 6 characters' }
    return
  }

  const cred = await getCredentials()
  if (!cred) {
    ctx.status = 400
    ctx.body = { error: 'Password login not configured' }
    return
  }

  // Verify current password — use the username from stored credentials
  const valid = await verifyCredentials(cred.username, currentPassword)
  if (!valid) {
    ctx.status = 400
    ctx.body = { error: 'Current password is incorrect' }
    return
  }

  await setCredentials(cred.username, newPassword)
  ctx.body = { success: true }
}

/**
 * POST /api/auth/change-username
 * Change username (protected).
 */
export async function changeUsername(ctx: Context) {
  const { currentPassword, newUsername } = ctx.request.body as { currentPassword?: string; newUsername?: string }
  if (!currentPassword || !newUsername) {
    ctx.status = 400
    ctx.body = { error: 'Current password and new username are required' }
    return
  }
  if (newUsername.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }

  const cred = await getCredentials()
  if (!cred) {
    ctx.status = 400
    ctx.body = { error: 'Password login not configured' }
    return
  }

  const valid = await verifyCredentials(cred.username, currentPassword)
  if (!valid) {
    ctx.status = 400
    ctx.body = { error: 'Current password is incorrect' }
    return
  }

  // Update username, keep the same password
  await setCredentials(newUsername, currentPassword)
  ctx.body = { success: true }
}

/**
 * DELETE /api/auth/password
 * Remove username/password login (protected).
 */
export async function removePassword(ctx: Context) {
  await deleteCredentials()
  ctx.body = { success: true }
}
