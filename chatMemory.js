import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });
client.on('error', err => console.error('Redis error:', err));
await client.connect();          // runs once at boot

const TTL = Number(process.env.CHAT_TTL_SECONDS || 86400);

export async function getContext(psid) {
  const raw = await client.get(`chat:${psid}`);
  return raw ? JSON.parse(raw) : [];
}

export async function setContext(psid, messages) {
  const trimmed = messages.slice(-10);          // keep last 10 turns
  await client.setEx(`chat:${psid}`, TTL, JSON.stringify(trimmed));
}

export async function getAllUserIds() {
  const keys = await client.keys('chat:*');
  return keys.map(key => key.replace('chat:', ''));
}

export async function getUsersWithProfiles(lineClient) {
  const userIds = await getAllUserIds();
  const usersWithProfiles = [];

  for (const userId of userIds) {
    try {
      const profile = await lineClient.getProfile(userId);
      usersWithProfiles.push({
        userId,
        displayName: profile.displayName || 'Unknown',
        pictureUrl: profile.pictureUrl || null,
        statusMessage: profile.statusMessage || null
      });
    } catch (error) {
      // If we can't get profile (user blocked bot, etc), still include the userId
      console.warn(`Failed to get profile for ${userId}:`, error?.message);
      usersWithProfiles.push({
        userId,
        displayName: 'Profile Unavailable',
        pictureUrl: null,
        statusMessage: null
      });
    }
  }

  return usersWithProfiles;
}
