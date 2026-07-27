export function createRateLimiter(limit, windowMs, now = Date.now) {
  const visits = new Map();
  return key => {
    const current = now();
    const recent = (visits.get(key) || []).filter(time => current - time < windowMs);
    if (recent.length >= limit) return false;
    recent.push(current);
    visits.set(key, recent);
    return true;
  };
}
