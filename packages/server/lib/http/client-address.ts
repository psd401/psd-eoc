/**
 * The caller's address as the platform saw it.
 *
 * App Runner terminates in front of the listener and appends the address it
 * accepted the connection from to `x-forwarded-for`. Everything to the left
 * of that entry arrived from the caller and may be anything, so only the
 * right-most entry can key a per-caller budget. Null when there is no usable
 * entry; the caller then shares one bucket with every other such request.
 */
export function forwardedClientAddress(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const last = forwarded.split(',').at(-1)?.trim() ?? '';
  return last.length > 0 && last.length <= 64 ? last : null;
}
