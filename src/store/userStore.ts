import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface UserRecord {
  id: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  appId: string;
  createdAt: string;
  updatedAt: string;
}

interface PersistedState {
  users: UserRecord[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function validUsername(value: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]{2,63}$/i.test(value);
}

export function validateNewUserCredentials(usernameInput: string, password: string): string {
  const username = normalizeUsername(usernameInput);
  if (!validUsername(username)) {
    throw new Error('Username must be 3–64 characters and use only letters, numbers, dot, dash, or underscore.');
  }
  if (password.length < 12 || password.length > 256) {
    throw new Error('Password must be 12–256 characters.');
  }
  return username;
}

function passwordHash(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString('base64');
}

const DUMMY_SALT = 'gemrouter-user-store-dummy-salt';

export function createUserId(): string {
  return `usr_${randomBytes(10).toString('hex')}`;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class UserStore {
  private state: PersistedState = { users: [] };

  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
    try { chmodSync(filePath, 0o600); } catch { /* The file is created on first sign-up. */ }
  }

  list(): UserRecord[] {
    return [...this.state.users];
  }

  findById(id: string): UserRecord | undefined {
    return this.state.users.find((user) => user.id === id);
  }

  findByUsername(username: string): UserRecord | undefined {
    const normalized = normalizeUsername(username);
    return this.state.users.find((user) => user.username === normalized);
  }

  create(input: { id?: string; username: string; password: string; appId: string }): UserRecord {
    const username = validateNewUserCredentials(input.username, input.password);
    if (this.findByUsername(username)) {
      throw new Error('Username is already in use.');
    }
    const salt = randomBytes(16).toString('base64');
    const timestamp = nowIso();
    const user: UserRecord = {
      id: input.id?.trim() || createUserId(),
      username,
      passwordSalt: salt,
      passwordHash: passwordHash(input.password, salt),
      appId: input.appId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.users.push(user);
    this.save();
    return user;
  }

  verify(username: string, password: string): UserRecord | null {
    const user = this.findByUsername(username);
    const candidate = passwordHash(password, user?.passwordSalt ?? DUMMY_SALT);
    if (!user) return null;
    return secureEqual(candidate, user.passwordHash) ? user : null;
  }

  remove(id: string): UserRecord | null {
    const index = this.state.users.findIndex((user) => user.id === id);
    if (index < 0) return null;
    const [removed] = this.state.users.splice(index, 1);
    this.save();
    return removed;
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedState;
      this.state = { users: Array.isArray(parsed.users) ? parsed.users : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = { users: [] };
        return;
      }
      throw new Error(`Unable to load user store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private save(): void {
    const temporaryPath = `${this.filePath}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
