-- ═══════════════════════════════════════════════════════════════════════════
-- 048 — Activation platform seed: Seattle market, requirement definitions,
-- versioned legal documents.
-- All legal text is ORIGINAL TAKEME DRAFT COPY and is marked for legal
-- counsel review before public launch (config/compliance flags below).
-- Jurisdictional requirements carry config.compliance_review = true and must
-- be confirmed by compliance before market activation.
-- Idempotent: ON CONFLICT DO NOTHING keyed on natural keys.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Seattle market ──────────────────────────────────────────────────────
INSERT INTO onboarding_markets (key, country_code, region_code, city, display_name, status, policies)
VALUES (
  'seattle_wa_us', 'US', 'WA', 'Seattle', 'Seattle, Washington', 'active',
  '{
    "ev": {
      "require_battery_electric": true,
      "min_model_year": 2017,
      "min_doors": 4,
      "min_seatbelts": 4,
      "max_vehicle_age_years": 10
    },
    "airports": ["SEA"],
    "license_jurisdictions": ["WA"],
    "document_renewal_reminder_days": [30, 14, 7, 1]
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- ── 2. Global requirement definitions ──────────────────────────────────────
INSERT INTO requirement_definitions
  (key, market_id, applicant_types, vehicle_relationships, category, required,
   blocking, review_method, title, summary, instructions, external_url,
   doc_kinds, depends_on, config, sort_order)
VALUES
  ('profile_details', NULL, NULL, NULL, 'identity', TRUE, TRUE, 'auto',
   'Your details',
   'Your legal name and contact details, exactly as they appear on your license.',
   'We use this to verify your identity and keep your account secure.',
   NULL, NULL, NULL, '{}'::jsonb, 10),

  ('legal_agreements', NULL, NULL, NULL, 'legal', TRUE, TRUE, 'auto',
   'Agreements',
   'Review and accept the TAKEME driver agreements.',
   'Each agreement is versioned. You can re-read anything you accepted at any time.',
   NULL, NULL, NULL,
   '{"legal_keys": ["driver_terms", "privacy_policy", "electronic_communications", "driver_agreement"], "legal_review_pending": true}'::jsonb,
   20),

  ('drivers_license', NULL, NULL, NULL, 'identity', TRUE, TRUE, 'document_review',
   'Driver''s license',
   'A clear photo of the front and back of your valid driver''s license.',
   'Place the license on a dark, non-reflective surface. All four corners must be visible and the text readable.',
   NULL, ARRAY['license_front', 'license_back'], NULL,
   '{"requires_back": true, "expiry_source": "document", "renewal_window_days": 30}'::jsonb,
   30),

  ('profile_photo', NULL, NULL, NULL, 'identity', TRUE, TRUE, 'document_review',
   'Profile photo',
   'A clear, front-facing photo so riders can recognize you.',
   'Face the camera in good light. No sunglasses, and nothing covering your face. This photo is reviewed against your license.',
   NULL, ARRAY['profile_photo'], ARRAY['drivers_license'],
   '{"camera_only": true}'::jsonb,
   40),

  ('vehicle_details', NULL, NULL,
   ARRAY['personal_owned', 'personal_leased', 'commercial_livery'],
   'vehicle', TRUE, TRUE, 'auto',
   'Your vehicle',
   'Tell us about the electric vehicle you''ll drive.',
   'TAKEME is electric-only. We verify your VIN against official vehicle data to confirm eligibility.',
   NULL, NULL, NULL, '{}'::jsonb, 50),

  ('rental_assignment', NULL, NULL, ARRAY['takeme_rental'],
   'vehicle', TRUE, TRUE, 'manual',
   'TAKEME rental vehicle',
   'We''ll match you with an electric vehicle from the TAKEME fleet.',
   'When a vehicle in your market becomes available, we''ll notify you and complete this step for you.',
   NULL, NULL, NULL, '{}'::jsonb, 50),

  ('fleet_membership', NULL, ARRAY['fleet_driver'], NULL,
   'vehicle', TRUE, TRUE, 'manual',
   'Fleet assignment',
   'Your fleet operator assigns your vehicle and confirms your membership.',
   'Ask your fleet operator to confirm your membership from their TAKEME fleet account. We''ll update this step automatically.',
   NULL, NULL, NULL, '{}'::jsonb, 50),

  ('fleet_owner_setup', NULL, ARRAY['fleet_owner'], NULL,
   'vehicle', TRUE, TRUE, 'manual',
   'Fleet account',
   'Set up your TAKEME fleet account, vehicles, and documents.',
   'Fleet accounts are managed on the TAKEME fleet portal. Complete owner verification and vehicle listings there; this step updates automatically.',
   'https://www.takememobility.com/fleet', NULL, NULL, '{}'::jsonb, 50),

  ('vehicle_registration', NULL, NULL,
   ARRAY['personal_owned', 'personal_leased', 'commercial_livery'],
   'vehicle', TRUE, TRUE, 'document_review',
   'Vehicle registration',
   'Your current vehicle registration.',
   'Photograph the full registration document. The name, plate, VIN, and expiration date must be readable.',
   NULL, ARRAY['registration'], ARRAY['vehicle_details'],
   '{"expiry_source": "document", "renewal_window_days": 30}'::jsonb,
   60),

  ('vehicle_insurance', NULL, NULL,
   ARRAY['personal_owned', 'personal_leased', 'commercial_livery'],
   'vehicle', TRUE, TRUE, 'document_review',
   'Personal insurance',
   'Proof of insurance listing you as a covered driver.',
   'Photograph your current insurance card or declaration page. Your name, the vehicle, and the policy dates must be visible.',
   NULL, ARRAY['insurance'], ARRAY['vehicle_details'],
   '{"expiry_source": "document", "renewal_window_days": 30}'::jsonb,
   70),

  ('background_check', NULL, NULL, NULL, 'background', TRUE, TRUE, 'provider',
   'Background check',
   'A standard driving-record and criminal-background screening.',
   'You''ll review the required disclosures, then authorize the check. Sensitive details like your Social Security number are collected directly by our screening partner — TAKEME never sees or stores them.',
   NULL, NULL, ARRAY['legal_agreements', 'drivers_license'],
   '{"disclosure_keys": ["background_check_disclosure", "background_check_authorization"]}'::jsonb,
   80),

  ('safety_training', NULL, NULL, NULL, 'training', TRUE, TRUE, 'quiz',
   'Community safety essentials',
   'A short course on safety, accessibility, and rider privacy.',
   'Read each section, then pass a short check. You can retake it if you need to.',
   NULL, NULL, NULL,
   '{"module_version": 1, "pass_score": 80, "max_attempts": 5,
     "sections": [
       {"title": "Safe driving, every trip", "body": "Always complete trips in the app so every ride is tracked and insured. Follow posted speed limits, never use a handheld phone while moving, and take breaks when you are tired. If you ever feel unsafe, end the trip in a safe public place and contact TAKEME support."},
       {"title": "Service animals and accessibility", "body": "Riders with service animals must always be accepted, even if you have a pet-free preference. Refusing a service animal violates the law and TAKEME policy. Offer reasonable help with mobility devices, and keep your vehicle accessible and clutter-free."},
       {"title": "Respect and anti-harassment", "body": "Treat every rider with respect regardless of who they are. Harassment, discrimination, and unwanted personal comments or contact are never acceptable and lead to permanent deactivation. Keep conversation professional and follow the rider''s lead."},
       {"title": "Rider privacy", "body": "Rider names, addresses, and trip details are confidential. Never contact a rider outside the app, share their information, or photograph them. All trip communication stays in TAKEME messaging."},
       {"title": "Electric vehicle readiness", "body": "Start shifts with enough charge to complete trips comfortably, plan charging around demand, and never accept a trip you cannot complete on your remaining range. If a vehicle fault light appears, finish safely, then have the issue resolved before going online again."}
     ],
     "questions": [
       {"id": "q1", "prompt": "A rider approaches with a service animal, but you keep a pet-free car. What do you do?", "options": ["Politely decline the trip", "Accept the trip — service animals are always welcome", "Ask the rider to book a pet-friendly ride"], "answer": 1},
       {"id": "q2", "prompt": "Where should all communication with riders happen?", "options": ["Your personal phone, after the trip", "Inside the TAKEME app", "Any messaging app the rider prefers"], "answer": 1},
       {"id": "q3", "prompt": "You feel unsafe during a trip. What is the right first step?", "options": ["Stop immediately wherever you are", "End the trip in a safe public place and contact support", "Continue and report it after the trip"], "answer": 1},
       {"id": "q4", "prompt": "Before going online, your battery is at 12%. What should you do?", "options": ["Go online — short trips might come in", "Charge first so you can complete trips comfortably", "Go online but decline long trips"], "answer": 1},
       {"id": "q5", "prompt": "A rider leaves a phone in your car. What do you do?", "options": ["Report it in the app and follow the return steps", "Look through it to find the owner", "Keep it until the rider contacts you directly"], "answer": 0}
     ]}'::jsonb,
   90),

  ('payout_setup', NULL, NULL, NULL, 'opportunity', FALSE, FALSE, 'none',
   'Payout method',
   'Choose how you get paid — set this up any time before your first payout.',
   'You can drive before finishing this step. Set up your payout method from the Earnings tab whenever you''re ready.',
   NULL, NULL, NULL, '{}'::jsonb, 200)
ON CONFLICT (key, market_id) DO NOTHING;

-- ── 3. Seattle / Washington market requirements ────────────────────────────
-- Jurisdictional rules: modeled from public Washington / King County / Port
-- of Seattle programs. compliance_review = true → compliance team must
-- confirm before these gate real activations.
INSERT INTO requirement_definitions
  (key, market_id, applicant_types, vehicle_relationships, category, required,
   blocking, review_method, title, summary, instructions, external_url,
   doc_kinds, depends_on, config, sort_order)
SELECT v.key, m.id, v.applicant_types, v.vehicle_relationships, v.category,
       v.required, v.blocking, v.review_method, v.title, v.summary,
       v.instructions, v.external_url, v.doc_kinds, v.depends_on, v.config, v.sort_order
FROM onboarding_markets m,
LATERAL (VALUES
  ('wa_for_hire_permit',
   ARRAY['individual_owner', 'individual_lease', 'rental_seeker', 'fleet_driver'],
   NULL::text[], 'market_permit', TRUE, TRUE, 'document_review',
   'King County for-hire driver''s license',
   'The for-hire driver''s license required to drive passengers in King County.',
   'Apply through King County Records and Licensing Services, then photograph your permit card. Your name and expiration date must be readable.',
   'https://kingcounty.gov/en/dept/executive-services/certificates-permits-licenses/for-hire-driver-licensing',
   ARRAY['for_hire_permit'], ARRAY['drivers_license'],
   '{"compliance_review": true, "expiry_source": "document", "renewal_window_days": 30}'::jsonb, 100),

  ('wa_chauffeur_credential',
   ARRAY['livery_operator', 'subcarrier'], NULL::text[],
   'market_permit', TRUE, TRUE, 'document_review',
   'Washington chauffeur credential',
   'Your Washington-issued chauffeur credential card.',
   'Photograph the front of your credential card. Your name, credential number, and expiration must be readable.',
   'https://dol.wa.gov/professional-licenses',
   ARRAY['chauffeur_credential'], ARRAY['drivers_license'],
   '{"compliance_review": true, "expiry_source": "document", "renewal_window_days": 30}'::jsonb, 110),

  ('wa_limousine_decal',
   ARRAY['livery_operator', 'subcarrier'],
   ARRAY['commercial_livery'],
   'market_permit', TRUE, TRUE, 'document_review',
   'Washington limousine decal',
   'The State of Washington limousine decal displayed on your vehicle.',
   'Photograph the decal where it''s displayed, next to your rear license plate. The decal number must be readable.',
   'https://dol.wa.gov/professional-licenses/limousine-businesses',
   ARRAY['limousine_decal'], ARRAY['vehicle_details'],
   '{"compliance_review": true, "expiry_source": "document", "renewal_window_days": 30}'::jsonb, 120),

  ('wa_business_license',
   ARRAY['livery_operator', 'subcarrier', 'fleet_owner'], NULL::text[],
   'market_permit', TRUE, TRUE, 'document_review',
   'Limousine business license',
   'Your Washington limousine carrier business license.',
   'Photograph or upload the license document. The business name and license number must be readable.',
   'https://dol.wa.gov/professional-licenses/limousine-businesses',
   ARRAY['business_license'], NULL,
   '{"compliance_review": true, "expiry_source": "document", "renewal_window_days": 30}'::jsonb, 130),

  ('commercial_liability_insurance',
   ARRAY['livery_operator', 'subcarrier', 'fleet_owner'], NULL::text[],
   'market_permit', TRUE, TRUE, 'document_review',
   'Certificate of liability insurance',
   'Commercial liability coverage meeting Washington limousine requirements.',
   'Upload your current certificate of liability. The insured business, coverage limits, and policy dates must be visible.',
   NULL,
   ARRAY['liability_certificate'], NULL,
   '{"compliance_review": true, "expiry_source": "document", "renewal_window_days": 30}'::jsonb, 140),

  ('subcarrier_agreement_step',
   ARRAY['subcarrier'], NULL::text[],
   'legal', TRUE, TRUE, 'auto',
   'Owner-operator agreement',
   'The agreement covering owner-operators driving under TAKEME''s carrier authority.',
   'Review and accept the owner-operator terms. This is versioned like every other agreement.',
   NULL, NULL, NULL,
   '{"legal_keys": ["subcarrier_agreement"], "legal_review_pending": true}'::jsonb, 150),

  ('seatac_airport_permit',
   NULL::text[], NULL::text[],
   'opportunity', FALSE, FALSE, 'document_review',
   'SEA airport pickups',
   'Optional: get permitted for pre-arranged pickups at Seattle-Tacoma International.',
   'Airport pickups require a Port of Seattle permit. Apply with the Port, then upload your permit here. You can drive everywhere else without it.',
   'https://www.portseattle.org/page/ground-transportation-providers',
   ARRAY['airport_permit'], NULL,
   '{"compliance_review": true, "expiry_source": "document", "renewal_window_days": 30}'::jsonb, 210),

  ('seattle_geography_training',
   NULL::text[], NULL::text[],
   'opportunity', FALSE, FALSE, 'quiz',
   'Know Seattle',
   'Optional: a quick guide to Seattle pickup zones, hotspots, and airport flow.',
   'A short read on where demand concentrates and how SEA airport staging works. Optional, but it helps your first week.',
   NULL, NULL, NULL,
   '{"module_version": 1, "pass_score": 60, "max_attempts": 10,
     "sections": [
       {"title": "Where demand lives", "body": "Weekday mornings concentrate around Capitol Hill, Belltown, and South Lake Union toward downtown. Evenings reverse the flow. Stadium events at Lumen Field and T-Mobile Park create short, intense surges — position early, not during."},
       {"title": "SEA airport flow", "body": "All rideshare pickups at Seattle-Tacoma International stage on the third floor of the parking garage. Follow airport wayfinding to the TNC area and wait for your rider there — curbside arrivals pickups are not permitted."},
       {"title": "Ferries and bridges", "body": "Ferry arrivals at Colman Dock release predictable waves of riders. The West Seattle and SR-520 bridges shape trip times more than distance does — the in-app route accounts for tolls and closures."}
     ],
     "questions": [
       {"id": "q1", "prompt": "Where do rideshare pickups happen at SEA?", "options": ["Arrivals curb", "Third floor of the parking garage", "Departures drive"], "answer": 1},
       {"id": "q2", "prompt": "When is the best time to position for a stadium event?", "options": ["Before the event lets out", "During the final inning or quarter", "After the surge starts"], "answer": 0}
     ]}'::jsonb, 220)
) AS v(key, applicant_types, vehicle_relationships, category, required, blocking,
       review_method, title, summary, instructions, external_url, doc_kinds,
       depends_on, config, sort_order)
WHERE m.key = 'seattle_wa_us'
ON CONFLICT (key, market_id) DO NOTHING;

-- ── 4. Versioned legal documents (ORIGINAL DRAFT COPY — counsel review) ────
INSERT INTO legal_documents (key, version, locale, title, body, content_hash, requires_scroll)
SELECT d.key, 1, 'en', d.title, d.body, encode(sha256(d.body::bytea), 'hex'), d.requires_scroll
FROM (VALUES
  ('driver_terms', 'TAKEME Driver Terms of Service',
   E'DRAFT — PENDING LEGAL COUNSEL REVIEW\n\nThese Driver Terms of Service ("Terms") govern your access to and use of the TAKEME platform as a driver.\n\n1. The platform. TAKEME provides technology that connects riders with independent drivers of electric vehicles. TAKEME is not a transportation carrier for trips you provide, except where local law requires otherwise.\n\n2. Eligibility. You must hold a valid driver''s license, meet the requirements shown in your Activation Center for your market, and keep them current. TAKEME may suspend platform access while a required item is missing, expired, or under review.\n\n3. Your account. Keep your credentials secure and your information accurate. Your account is personal and may not be shared or transferred.\n\n4. Conduct. You agree to comply with applicable law, drive safely, treat riders with respect, and never discriminate. Service animals must always be accommodated.\n\n5. Earnings and fees. Trip earnings, fees, and payout timing are shown in the app before and after each trip. TAKEME may correct calculation errors and will show you the correction.\n\n6. Suspension and deactivation. TAKEME may suspend or deactivate access for safety issues, fraud, legal or compliance failures, or material breach of these Terms, following the process described in our policies.\n\n7. Changes. When these Terms change, we will show you the new version and record which version you accepted.\n\nThis draft must be reviewed and completed by legal counsel before public launch.', TRUE),

  ('privacy_policy', 'TAKEME Privacy Policy (Driver)',
   E'DRAFT — PENDING LEGAL COUNSEL REVIEW\n\nThis notice explains how TAKEME handles your information as a driver applicant and driver.\n\nWhat we collect: identity and contact details, license and vehicle information, documents you submit, trip and location data while you are online, and payment details needed to pay you.\n\nBackground screening: sensitive identifiers such as your Social Security number are collected directly by our screening partner and are not stored on TAKEME systems.\n\nHow we use it: verifying eligibility, operating and improving the platform, safety, support, payments, and legal compliance.\n\nSharing: with riders (your first name, photo, vehicle, and plate), with service providers under contract, and where the law requires.\n\nYour choices: you can access your information, correct it, and request deletion of data we are not legally required to keep. Document retention follows the schedule for your market.\n\nThis draft must be reviewed and completed by legal counsel before public launch.', TRUE),

  ('electronic_communications', 'Electronic Communications Consent',
   E'DRAFT — PENDING LEGAL COUNSEL REVIEW\n\nYou agree that TAKEME may provide required notices, disclosures, agreements, and records electronically — in the app and by email or SMS to the contact details on your account.\n\nOperational messages (ride requests, document and application updates, safety alerts, and earnings notices) are part of using the platform. Marketing messages are optional and controlled separately in Settings, and you can opt out of them at any time.\n\nYou may request paper copies of records or withdraw this consent by contacting support; withdrawing it may prevent use of the platform.\n\nThis draft must be reviewed and completed by legal counsel before public launch.', FALSE),

  ('driver_agreement', 'Independent Driver Agreement',
   E'DRAFT — PENDING LEGAL COUNSEL REVIEW\n\nThis agreement describes the relationship between you and TAKEME when you provide transportation using the platform.\n\n1. Independent relationship. You provide services as an independent business, not as a TAKEME employee. You choose when and where to go online, and you may decline requests, subject to platform policies applied consistently.\n\n2. Your obligations. Maintain the licenses, permits, insurance, and vehicle standards required in your market; provide services safely and lawfully; and keep required documents current in the app.\n\n3. Vehicle. Your vehicle must be a battery-electric vehicle meeting your market''s eligibility policy and must pass any required verification.\n\n4. Payments. TAKEME collects rider payments on your behalf and remits your earnings as shown in the app, less disclosed fees.\n\n5. Insurance. Coverage during platform use is described in the insurance summary for your market. You must also maintain the personal or commercial coverage required by law.\n\n6. Term and termination. Either party may end this agreement at any time; sections that by nature survive (payments owed, records, disputes) survive termination.\n\nThis draft must be reviewed and completed by legal counsel — including any arbitration and classification provisions — before public launch.', TRUE),

  ('background_check_disclosure', 'Background Check Disclosure',
   E'DRAFT — PENDING LEGAL COUNSEL REVIEW\n\nDISCLOSURE REGARDING CONSUMER REPORTS\n\nTAKEME may obtain consumer reports about you from a consumer reporting agency for purposes of evaluating your driver application and, on an ongoing basis, your continued eligibility. These reports may include your driving record and criminal history as permitted by law.\n\nThe reports are prepared by TAKEME''s screening partner, a consumer reporting agency. You may request the agency''s contact details and a copy of your report.\n\nThis standalone disclosure is provided separately from the application and other documents, as required by the Fair Credit Reporting Act.\n\nThis draft must be reviewed by legal counsel for FCRA and Washington-specific requirements before use.', TRUE),

  ('background_check_authorization', 'Background Check Authorization',
   E'DRAFT — PENDING LEGAL COUNSEL REVIEW\n\nAUTHORIZATION\n\nI have read the Background Check Disclosure. I authorize TAKEME and its screening partner to obtain the consumer reports described in the disclosure, both for my application and on an ongoing basis while I remain active on the platform, as permitted by law.\n\nI understand that information needed for the check — including my Social Security number — will be provided by me directly to the screening partner, and that I may withdraw this authorization at any time by contacting support, which will end my eligibility to drive.\n\nThis draft must be reviewed by legal counsel before use.', FALSE),

  ('subcarrier_agreement', 'Owner-Operator (Subcarrier) Agreement',
   E'DRAFT — PENDING LEGAL COUNSEL REVIEW\n\nThis agreement applies to owner-operators providing limousine or livery service through the TAKEME platform under their own or TAKEME''s carrier authority in Washington.\n\n1. Authority and permits. You represent that you hold, and will maintain, every business license, chauffeur credential, vehicle decal, and insurance certificate required by the State of Washington and by the jurisdictions where you operate.\n\n2. Vehicles. Vehicles operated under this agreement must be battery-electric, meet market eligibility policy, and display all required markings.\n\n3. Compliance. You will present current documents in the app before their expiration. Operating with an expired credential suspends platform access automatically.\n\n4. Relationship. You are an independent business. Nothing in this agreement creates an employment, agency, or joint-venture relationship.\n\nThis draft must be reviewed and completed by legal counsel before use.', TRUE)
) AS d(key, title, body, requires_scroll)
ON CONFLICT (key, version, locale) DO NOTHING;

NOTIFY pgrst, 'reload schema';
