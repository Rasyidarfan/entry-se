-- ─────────────────────────────────────────────────────────────────────────────
-- SE2026 Entry — skema MySQL (§4 rancangan-backend.md)
-- Charset utf8mb4, InnoDB, ID CHAR(36) UUID agar konsisten dengan FASIH.
-- ─────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- 4.1 users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `users` (
  `id`            CHAR(36)      NOT NULL,
  `username`      VARCHAR(64)   NOT NULL,
  `password_hash` VARCHAR(255)  NOT NULL,
  `fullname`      VARCHAR(128)  NULL,
  `email`         VARCHAR(128)  NULL,
  `role`          ENUM('admin','mitra') NOT NULL DEFAULT 'mitra',
  `is_active`     TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4.2 regions (master wilayah s.d. SLS/Sub-SLS) ────────────────────────────────
CREATE TABLE IF NOT EXISTS `regions` (
  `id`        CHAR(36)     NOT NULL,
  `level`     ENUM('prov','kab','kec','desa','sls','subsls') NOT NULL,
  `code`      VARCHAR(16)  NOT NULL,
  `fullcode`  VARCHAR(32)  NOT NULL,
  `name`      VARCHAR(128) NULL,
  `parent_id` CHAR(36)     NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_regions_fullcode` (`fullcode`),
  KEY `ix_regions_level` (`level`),
  KEY `ix_regions_parent` (`parent_id`),
  CONSTRAINT `fk_regions_parent` FOREIGN KEY (`parent_id`) REFERENCES `regions` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4.3 user_regions (pembatasan wilayah mitra) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS `user_regions` (
  `user_id`   CHAR(36) NOT NULL,
  `region_id` CHAR(36) NOT NULL,
  PRIMARY KEY (`user_id`, `region_id`),
  KEY `ix_user_regions_region` (`region_id`),
  CONSTRAINT `fk_ur_user`   FOREIGN KEY (`user_id`)   REFERENCES `users` (`id`)   ON DELETE CASCADE,
  CONSTRAINT `fk_ur_region` FOREIGN KEY (`region_id`) REFERENCES `regions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4.4 assignments (satu baris = satu target pendataan) ─────────────────────────
CREATE TABLE IF NOT EXISTS `assignments` (
  `id`                  CHAR(36)     NOT NULL,
  `kode_identitas`      VARCHAR(64)  NULL,
  `nama`                VARCHAR(160) NULL,
  `alamat_prelist`      VARCHAR(160) NULL,
  `nomor_urut_bangunan` VARCHAR(32)  NULL,
  `idsbr`               VARCHAR(32)  NULL,
  `nib`                 VARCHAR(32)  NULL,
  `email`               VARCHAR(128) NULL,
  `prelist_type`        ENUM('keluarga','usaha') NOT NULL DEFAULT 'keluarga',
  `mode`                ENUM('CAPI','CAWI') NOT NULL DEFAULT 'CAPI',
  `status`              ENUM('open','progress','done','clean','error') NOT NULL DEFAULT 'open',
  `region_id`           CHAR(36)     NULL,
  `region_fullcode`     VARCHAR(32)  NULL,
  `prov_code`           VARCHAR(16)  NULL,
  `kab_code`            VARCHAR(16)  NULL,
  `kec_code`            VARCHAR(16)  NULL,
  `desa_code`           VARCHAR(16)  NULL,
  `sls_code`            VARCHAR(16)  NULL,
  `subsls_code`         VARCHAR(16)  NULL,
  `sample_type`         VARCHAR(32)  NULL,
  `pengawas_id`         CHAR(36)     NULL,
  `pencacah_id`         CHAR(36)     NULL,
  `predefined`          JSON         NULL,
  `created_at`          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_assign_region_fullcode` (`region_fullcode`),
  KEY `ix_assign_status` (`status`),
  KEY `ix_assign_prelist_type` (`prelist_type`),
  KEY `ix_assign_pencacah` (`pencacah_id`),
  KEY `ix_assign_pengawas` (`pengawas_id`),
  KEY `ix_assign_wilayah` (`prov_code`,`kab_code`,`kec_code`,`desa_code`,`sls_code`),
  CONSTRAINT `fk_assign_region`   FOREIGN KEY (`region_id`)   REFERENCES `regions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_assign_pengawas` FOREIGN KEY (`pengawas_id`) REFERENCES `users` (`id`)   ON DELETE SET NULL,
  CONSTRAINT `fk_assign_pencacah` FOREIGN KEY (`pencacah_id`) REFERENCES `users` (`id`)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4.5 submissions (1:1 per assignment) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `submissions` (
  `id`               CHAR(36)    NOT NULL,
  `assignment_id`    CHAR(36)    NOT NULL,
  `template_id`      VARCHAR(64) NULL,
  `template_version` VARCHAR(16) NULL,
  `answers`          JSON        NULL,
  `summary`          JSON        NULL,
  `status`           ENUM('draft','submitted') NOT NULL DEFAULT 'draft',
  `filled_by`        CHAR(36)    NULL,
  `created_at`       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_submissions_assignment` (`assignment_id`),
  KEY `ix_submissions_filledby` (`filled_by`),
  CONSTRAINT `fk_sub_assignment` FOREIGN KEY (`assignment_id`) REFERENCES `assignments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sub_filledby`   FOREIGN KEY (`filled_by`)     REFERENCES `users` (`id`)       ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4.6 audit_logs ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT,
  `user_id`    CHAR(36)     NULL,
  `action`     VARCHAR(64)  NOT NULL,
  `entity`     VARCHAR(32)  NULL,
  `entity_id`  VARCHAR(64)  NULL,
  `diff`       JSON         NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_audit_user` (`user_id`),
  KEY `ix_audit_entity` (`entity`,`entity_id`),
  CONSTRAINT `fk_audit_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
