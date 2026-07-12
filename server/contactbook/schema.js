async function ensureContactBookSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS contact_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('APPLE','GOOGLE','GENERIC_CARDDAV')),
      display_name TEXT NOT NULL,
      account_identifier TEXT NOT NULL DEFAULT '',
      discovery_url TEXT NOT NULL,
      principal_url TEXT,
      addressbook_home_url TEXT,
      auth_type TEXT NOT NULL CHECK (auth_type IN ('OAUTH2','APP_PASSWORD','BASIC')),
      username TEXT,
      credential_encrypted TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONNECTED',
      auto_sync_enabled BOOLEAN NOT NULL DEFAULT true,
      last_sync_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_error_message_safe TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS contact_addressbooks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES contact_accounts(id) ON DELETE CASCADE,
      remote_url TEXT NOT NULL,
      remote_display_name TEXT NOT NULL DEFAULT 'Contacts',
      read_only BOOLEAN NOT NULL DEFAULT true,
      selected_for_sync BOOLEAN NOT NULL DEFAULT true,
      supports_sync_collection BOOLEAN NOT NULL DEFAULT false,
      sync_token TEXT,
      ctag TEXT,
      last_full_sync_at TIMESTAMPTZ,
      last_incremental_sync_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (account_id, remote_url)
    );

    CREATE TABLE IF NOT EXISTS contact_resources (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES contact_accounts(id) ON DELETE CASCADE,
      addressbook_id UUID NOT NULL REFERENCES contact_addressbooks(id) ON DELETE CASCADE,
      remote_href TEXT NOT NULL,
      remote_uid TEXT,
      etag TEXT,
      raw_vcard_encrypted TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      deleted_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (addressbook_id, remote_href)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_resource_id UUID NOT NULL UNIQUE REFERENCES contact_resources(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL DEFAULT '',
      given_name TEXT NOT NULL DEFAULT '',
      family_name TEXT NOT NULL DEFAULT '',
      nickname TEXT NOT NULL DEFAULT '',
      organization TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      job_title TEXT NOT NULL DEFAULT '',
      birthday TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      emails JSONB NOT NULL DEFAULT '[]',
      phones JSONB NOT NULL DEFAULT '[]',
      addresses JSONB NOT NULL DEFAULT '[]',
      urls JSONB NOT NULL DEFAULT '[]',
      search_text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_contact_accounts_owner ON contact_accounts(tenant_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_contact_books_owner ON contact_addressbooks(tenant_id, user_id, account_id);
    CREATE INDEX IF NOT EXISTS idx_contact_resources_owner ON contact_resources(tenant_id, user_id, addressbook_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_owner_name ON contacts(tenant_id, user_id, display_name);
    CREATE INDEX IF NOT EXISTS idx_contacts_owner_search ON contacts(tenant_id, user_id);
  `)
}

module.exports = { ensureContactBookSchema }
