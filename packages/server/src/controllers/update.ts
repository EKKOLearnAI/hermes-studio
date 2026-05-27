export async function handleUpdate(ctx: any) {
  ctx.status = 403
  ctx.body = {
    success: false,
    message: 'Quanthermes updates are managed by manual deployment only.',
  }
}
