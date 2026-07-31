import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from './migrations.js'

export type GatewayDatabase = Database.Database

export function openGatewayDatabase(databasePath: string): GatewayDatabase {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })

  const database = new Database(databasePath)
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')
  if (databasePath !== ':memory:') database.pragma('journal_mode = WAL')
  runMigrations(database)
  return database
}
