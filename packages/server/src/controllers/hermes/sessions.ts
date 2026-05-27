function requestedProfile(ctx: any): string | undefined {
  const queryProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile.trim() : ''
  const value = queryProfile || ctx.state?.profile?.name || ''
  return value || undefined
}