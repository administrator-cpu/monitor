-- 011_tls_certs_host: certificates keyed per host (phase 11, M2). See backend-schema.md section 13.4.
-- Until now `host` (the certificate's name) was the primary key, so two monitored hosts could not
-- both record a certificate for the same name. Every existing row is host 1 and is kept as it is.
-- No table references tls_certs, so the rebuild is safe with foreign_keys = ON.

CREATE TABLE tls_certs_new (
  host_id     INTEGER NOT NULL DEFAULT 1,
  host        TEXT    NOT NULL,
  not_after   INTEGER,
  issuer      TEXT,
  checked_at  INTEGER NOT NULL,
  last_error  TEXT,
  PRIMARY KEY (host_id, host)
);

INSERT INTO tls_certs_new (host_id, host, not_after, issuer, checked_at, last_error)
SELECT host_id, host, not_after, issuer, checked_at, last_error FROM tls_certs;

DROP TABLE tls_certs;
ALTER TABLE tls_certs_new RENAME TO tls_certs;
