import { Redis } from '@upstash/redis';
import type { Session } from '../types';

let _redis: Redis | null = null;
const getRedis = () => {
  if (!_redis) _redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  return _redis;
};

const TTL_SECONDS = 900; // 15 minutes
const key = (phone: string) => `session:${phone}`;

export async function getSession(phone: string): Promise<Session | null> {
  return getRedis().get<Session>(key(phone));
}

export async function setSession(phone: string, session: Session): Promise<void> {
  await getRedis().setex(key(phone), TTL_SECONDS, session);
}

export async function clearSession(phone: string): Promise<void> {
  await getRedis().del(key(phone));
}
