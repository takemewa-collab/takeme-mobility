-- ═══════════════════════════════════════════════════════════════════════════
-- 050 — provision_approved_driver: driver_wallets is keyed by driver_id
-- (the auth user id, per 011), not user_id. The 012 original and the 047
-- rewrite both carried the wrong column name; live E2E surfaced it.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION provision_approved_driver(p_application_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  app_record RECORD;
  new_driver_id UUID;
  mapped_class vehicle_class;
BEGIN
  SELECT * INTO app_record FROM driver_applications
  WHERE id = p_application_id AND status = 'approved';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Application % not found or not approved', p_application_id;
  END IF;

  SELECT id INTO new_driver_id FROM drivers WHERE auth_user_id = app_record.user_id;

  IF new_driver_id IS NULL THEN
    INSERT INTO drivers (
      full_name, email, phone, license_number, status,
      is_verified, is_active, auth_user_id
    ) VALUES (
      app_record.full_name, app_record.email, app_record.phone,
      COALESCE(app_record.license_number, ''), 'offline',
      TRUE, TRUE, app_record.user_id
    ) RETURNING id INTO new_driver_id;
  ELSE
    UPDATE drivers SET is_verified = TRUE, is_active = TRUE, updated_at = now()
    WHERE id = new_driver_id;
  END IF;

  mapped_class := CASE app_record.vehicle_class
    WHEN 'electric'         THEN 'economy'::vehicle_class
    WHEN 'comfort_electric' THEN 'comfort'::vehicle_class
    WHEN 'premium_electric' THEN 'premium'::vehicle_class
    WHEN 'suv_electric'     THEN 'premium'::vehicle_class
    ELSE 'economy'::vehicle_class
  END;

  IF app_record.vehicle_make IS NOT NULL AND app_record.plate_number IS NOT NULL THEN
    INSERT INTO vehicles (
      driver_id, vehicle_class, make, model, year, color, plate_number,
      capacity, is_active, vin, plate_state, doors, seatbelts, powertrain, body_type
    )
    SELECT
      new_driver_id, mapped_class, app_record.vehicle_make, app_record.vehicle_model,
      app_record.vehicle_year, app_record.vehicle_color, app_record.plate_number,
      COALESCE(app_record.seatbelts, 4), TRUE, app_record.vin, app_record.plate_state,
      app_record.doors, app_record.seatbelts, app_record.powertrain, app_record.body_type
    WHERE NOT EXISTS (
      SELECT 1 FROM vehicles v
      WHERE v.driver_id = new_driver_id AND v.is_active = TRUE
    );
  END IF;

  INSERT INTO driver_wallets (driver_id)
  VALUES (app_record.user_id)
  ON CONFLICT (driver_id) DO NOTHING;

  UPDATE driver_applications
  SET activated_at = COALESCE(activated_at, now()), updated_at = now()
  WHERE id = p_application_id;

  RETURN new_driver_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION provision_approved_driver(UUID) FROM anon, authenticated;
