-- Adds mesh_ids columns needed for multi-region support.
ALTER TABLE samples ADD COLUMN mesh_ids TEXT;
ALTER TABLE coverage ADD COLUMN mesh_ids TEXT;