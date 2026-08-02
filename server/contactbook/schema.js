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
      oauth_access_token_encrypted TEXT,
      oauth_refresh_token_encrypted TEXT,
      oauth_token_expires_at TIMESTAMPTZ,
      oauth_scopes TEXT[] NOT NULL DEFAULT '{}',
      oauth_subject TEXT,
      status TEXT NOT NULL DEFAULT 'CONNECTED',
      auto_sync_enabled BOOLEAN NOT NULL DEFAULT true,
      last_sync_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_error_message_safe TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS contact_oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('GOOGLE')),
      purpose TEXT NOT NULL CHECK (purpose IN ('CONTACTBOOK_CONNECT','CONTACTBOOK_REAUTHORIZE')),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id UUID REFERENCES contact_accounts(id) ON DELETE CASCADE,
      pkce_verifier_encrypted TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      identity_indexed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS people (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL DEFAULT '',
      primary_photo_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS person_contact_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      contact_id UUID NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL DEFAULT 'AUTO_PHONE' CHECK (link_type IN ('AUTO_PHONE','AUTO_EMAIL','MANUAL')),
      matched_phone TEXT,
      matched_email TEXT,
      match_status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (match_status IN ('CONFIRMED','REVIEW_REQUIRED','REJECTED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contact_phone_numbers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      raw_number TEXT NOT NULL,
      normalized_number TEXT NOT NULL,
      country_code TEXT,
      extension TEXT,
      type TEXT NOT NULL DEFAULT '',
      is_primary BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (contact_id, normalized_number)
    );

    CREATE TABLE IF NOT EXISTS contact_email_addresses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      raw_email TEXT NOT NULL,
      normalized_email TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '',
      is_primary BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (contact_id, normalized_email)
    );

    CREATE TABLE IF NOT EXISTS person_photos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      object_key TEXT NOT NULL UNIQUE,
      thumbnail_object_key TEXT,
      mime_type TEXT NOT NULL,
      byte_size BIGINT NOT NULL,
      width INTEGER,
      height INTEGER,
      sha256 TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'LOCAL' CHECK (source IN ('LOCAL','ICLOUD','GOOGLE')),
      source_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
      is_primary BOOLEAN NOT NULL DEFAULT false,
      caption TEXT NOT NULL DEFAULT '',
      taken_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS contact_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES contact_accounts(id) ON DELETE CASCADE,
      addressbook_id UUID NOT NULL REFERENCES contact_addressbooks(id) ON DELETE CASCADE,
      contact_resource_id UUID NOT NULL UNIQUE REFERENCES contact_resources(id) ON DELETE CASCADE,
      remote_uid TEXT,
      display_name TEXT NOT NULL DEFAULT '',
      group_kind TEXT NOT NULL DEFAULT 'GENERIC_GROUP' CHECK (group_kind IN ('ICLOUD_GROUP','GOOGLE_LABEL','GENERIC_GROUP')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS contact_group_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id UUID NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
      member_resource_id UUID REFERENCES contact_resources(id) ON DELETE SET NULL,
      member_kind TEXT NOT NULL DEFAULT 'CONTACT' CHECK (member_kind IN ('CONTACT','GROUP','EXTERNAL')),
      member_reference_raw TEXT NOT NULL,
      member_uid_normalized TEXT,
      resolution_status TEXT NOT NULL DEFAULT 'MISSING' CHECK (resolution_status IN ('RESOLVED','MISSING','EXTERNAL','INVALID')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (group_id, member_reference_raw)
    );

    CREATE INDEX IF NOT EXISTS idx_contact_accounts_owner ON contact_accounts(tenant_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_contact_oauth_states_expiry ON contact_oauth_states(expires_at);
    CREATE INDEX IF NOT EXISTS idx_contact_books_owner ON contact_addressbooks(tenant_id, user_id, account_id);
    CREATE INDEX IF NOT EXISTS idx_contact_resources_owner ON contact_resources(tenant_id, user_id, addressbook_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_owner_name ON contacts(tenant_id, user_id, display_name);
    CREATE INDEX IF NOT EXISTS idx_contacts_owner_search ON contacts(tenant_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_people_owner ON people(tenant_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_person_links_person ON person_contact_links(tenant_id, user_id, person_id);
    CREATE INDEX IF NOT EXISTS idx_contact_phones_match ON contact_phone_numbers(tenant_id, user_id, normalized_number);
    CREATE INDEX IF NOT EXISTS idx_contact_emails_match ON contact_email_addresses(tenant_id, user_id, normalized_email);
    CREATE INDEX IF NOT EXISTS idx_person_photos_person ON person_photos(tenant_id, user_id, person_id, created_at DESC) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_person_photos_primary ON person_photos(person_id) WHERE is_primary=true AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_contact_groups_owner ON contact_groups(tenant_id,user_id,account_id,addressbook_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_contact_group_members_group ON contact_group_members(tenant_id,user_id,group_id,sort_order);
    CREATE INDEX IF NOT EXISTS idx_contact_group_members_resource ON contact_group_members(member_resource_id) WHERE resolution_status='RESOLVED';
  `)
  await client.query('ALTER TABLE contact_accounts ADD COLUMN IF NOT EXISTS oauth_access_token_encrypted TEXT')
  await client.query('ALTER TABLE contact_accounts ADD COLUMN IF NOT EXISTS oauth_refresh_token_encrypted TEXT')
  await client.query('ALTER TABLE contact_accounts ADD COLUMN IF NOT EXISTS oauth_token_expires_at TIMESTAMPTZ')
  await client.query("ALTER TABLE contact_accounts ADD COLUMN IF NOT EXISTS oauth_scopes TEXT[] NOT NULL DEFAULT '{}'")
  await client.query('ALTER TABLE contact_accounts ADD COLUMN IF NOT EXISTS oauth_subject TEXT')
  await client.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS identity_indexed_at TIMESTAMPTZ')
  await client.query('ALTER TABLE person_contact_links ADD COLUMN IF NOT EXISTS matched_email TEXT')
  await client.query(`ALTER TABLE person_contact_links DROP CONSTRAINT IF EXISTS person_contact_links_link_type_check`)
  await client.query(`ALTER TABLE person_contact_links ADD CONSTRAINT person_contact_links_link_type_check
    CHECK (link_type IN ('AUTO_PHONE','AUTO_EMAIL','MANUAL'))`)
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='people_primary_photo_fk') THEN
      ALTER TABLE people ADD CONSTRAINT people_primary_photo_fk FOREIGN KEY (primary_photo_id) REFERENCES person_photos(id) ON DELETE SET NULL;
    END IF;
  END $$`)
}

module.exports = { ensureContactBookSchema }
