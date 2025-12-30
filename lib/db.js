'use strict';

const mysql = require('mysql2/promise');

function required(name, value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function createPoolFromEnv(env = process.env) {
  const host = required('DB_HOST', env.DB_HOST);
  const user = required('DB_USER', env.DB_USER);
  const password = env.DB_PASSWORD ?? '';
  const database = required('DB_NAME', env.DB_NAME);
  const port = env.DB_PORT ? Number(env.DB_PORT) : 3306;

  return mysql.createPool({
    host,
    user,
    password,
    database,
    port,
    waitForConnections: true,
    connectionLimit: env.DB_POOL_SIZE ? Number(env.DB_POOL_SIZE) : 10,
    queueLimit: 0,
    timezone: 'Z',
  });
}

module.exports = { createPoolFromEnv };
