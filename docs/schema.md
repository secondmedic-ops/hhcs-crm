# Database schema (generated from supabase/migrations - do not edit)

## access_log
| column | type | nullable |
|---|---|---|
| id | bigint | NO |
| workspace_id | uuid | YES |
| user_id | uuid | YES |
| action | text | NO |
| entity | text | YES |
| entity_id | text | YES |
| meta | jsonb | NO |
| at | timestamp with time zone | NO |
| staff_id | uuid | YES |
| staff_session_id | uuid | YES |

## approvals
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| case_id | uuid | YES |
| kind | text | NO |
| title | text | NO |
| payload | jsonb | NO |
| status | text | NO |
| requested_by | uuid | YES |
| requested_at | timestamp with time zone | NO |
| decided_by | uuid | YES |
| decided_at | timestamp with time zone | YES |
| decision_note | text | YES |

## assignments
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| case_id | uuid | NO |
| staff_id | uuid | NO |
| task | text | NO |
| status | text | NO |
| assigned_by | uuid | YES |
| assigned_at | timestamp with time zone | NO |
| eta | timestamp with time zone | YES |
| window_start | timestamp with time zone | YES |
| window_end | timestamp with time zone | YES |
| checkin_at | timestamp with time zone | YES |
| checkin_lat | double precision | YES |
| checkin_lng | double precision | YES |
| checkin_distance_m | integer | YES |
| checkout_at | timestamp with time zone | YES |
| checklist | jsonb | NO |
| patient_signoff | boolean | NO |
| backup_for | uuid | YES |
| delay_reason | text | YES |

## audit_log
| column | type | nullable |
|---|---|---|
| id | bigint | NO |
| workspace_id | uuid | YES |
| table_name | text | NO |
| record_id | uuid | YES |
| action | text | NO |
| changes | jsonb | YES |
| actor_id | uuid | YES |
| at | timestamp with time zone | NO |
| staff_id | uuid | YES |
| staff_session_id | uuid | YES |

## bmm_integration_settings
| column | type | nullable |
|---|---|---|
| workspace_id | uuid | NO |
| enabled | boolean | NO |
| contract_confirmed | boolean | NO |
| updated_by | uuid | YES |
| updated_at | timestamp with time zone | NO |

## bmm_status_events
| column | type | nullable |
|---|---|---|
| workspace_id | uuid | NO |
| event_id | uuid | NO |
| referral_id | uuid | NO |
| payload_hash | text | NO |
| applied_status | text | NO |
| applied_by | uuid | NO |
| received_at | timestamp with time zone | NO |

## callbacks
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| call_id | uuid | YES |
| number | text | NO |
| patient_id | uuid | YES |
| reason | text | NO |
| due_at | timestamp with time zone | NO |
| status | text | NO |
| assigned_to | uuid | YES |
| attempts | integer | NO |
| last_attempt_at | timestamp with time zone | YES |
| completed_at | timestamp with time zone | YES |
| completed_by | uuid | YES |
| notes | text | YES |
| created_at | timestamp with time zone | NO |
| next_attempt_at | timestamp with time zone | YES |
| auto_dialled | boolean | NO |

## calls
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| provider | text | NO |
| provider_call_id | text | YES |
| session_id | text | YES |
| direction | text | NO |
| customer_number | text | YES |
| did_number | text | YES |
| agent_id | uuid | YES |
| agent_name | text | YES |
| department | text | YES |
| status | text | NO |
| started_at | timestamp with time zone | NO |
| answered_at | timestamp with time zone | YES |
| ended_at | timestamp with time zone | YES |
| ring_seconds | integer | YES |
| talk_seconds | integer | YES |
| recording_filename | text | YES |
| patient_id | uuid | YES |
| case_id | uuid | YES |
| disposition | text | YES |
| notes | text | YES |
| transcript | text | YES |
| ai_summary | text | YES |
| ai_sentiment | text | YES |
| ai_intent | text | YES |
| ai_extracted | jsonb | YES |
| ai_flags | ARRAY | YES |
| ai_processed_at | timestamp with time zone | YES |
| click_to_call_ref | text | YES |
| raw | jsonb | YES |
| created_at | timestamp with time zone | NO |
| callback_id | uuid | YES |
| ai_status | text | YES |
| ai_error | text | YES |
| ai_attempts | integer | NO |
| ai_started_at | timestamp with time zone | YES |
| live_transcript | text | YES |
| live_transcript_started_at | timestamp with time zone | YES |
| live_transcript_completed_at | timestamp with time zone | YES |

## case_counters
| column | type | nullable |
|---|---|---|
| workspace_id | uuid | NO |
| day | date | NO |
| last_value | integer | NO |

## case_item_cost_history
| column | type | nullable |
|---|---|---|
| id | bigint | NO |
| case_item_id | uuid | NO |
| case_id | uuid | NO |
| workspace_id | uuid | NO |
| old | jsonb | YES |
| new | jsonb | NO |
| source | text | NO |
| reason | text | YES |
| changed_by | uuid | YES |
| changed_at | timestamp with time zone | NO |

## case_item_costs
| column | type | nullable |
|---|---|---|
| case_item_id | uuid | NO |
| case_id | uuid | NO |
| workspace_id | uuid | NO |
| provider_id | uuid | YES |
| provider_rate_id | uuid | YES |
| unit | text | YES |
| buy_rate | numeric | YES |
| tax_basis | text | YES |
| source | text | NO |
| note | text | YES |
| captured_by | uuid | YES |
| captured_at | timestamp with time zone | NO |

## case_items
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| case_id | uuid | NO |
| service_id | uuid | NO |
| service_code | text | YES |
| service_name | text | YES |
| category | text | YES |
| unit_price | numeric | NO |
| qty | integer | NO |
| line_total | numeric | NO |
| created_at | timestamp with time zone | NO |
| recommended | boolean | NO |
| excluded | boolean | NO |
| exclude_reason | text | YES |
| exclude_category | text | YES |
| unit | text | YES |
| price_version | integer | YES |
| price_tax_basis | text | YES |
| priced_at | timestamp with time zone | YES |

## case_journey_history
| column | type | nullable |
|---|---|---|
| id | bigint | NO |
| workspace_id | uuid | NO |
| case_id | uuid | NO |
| from_state | USER-DEFINED | YES |
| to_state | USER-DEFINED | NO |
| changed_by | uuid | YES |
| changed_at | timestamp with time zone | NO |

## case_referrals
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| case_id | uuid | NO |
| provider_id | uuid | NO |
| categories | ARRAY | NO |
| status | text | NO |
| auto | boolean | NO |
| assigned_to | uuid | YES |
| scheduled_at | timestamp with time zone | YES |
| accepted_at | timestamp with time zone | YES |
| started_at | timestamp with time zone | YES |
| completed_at | timestamp with time zone | YES |
| decline_reason | text | YES |
| last_note | text | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | NO |
| updated_at | timestamp with time zone | NO |
| dispatched_at | timestamp with time zone | YES |
| fulfilment_managed | boolean | NO |

## case_stage_history
| column | type | nullable |
|---|---|---|
| id | bigint | NO |
| case_id | uuid | NO |
| from_stage | USER-DEFINED | YES |
| to_stage | USER-DEFINED | NO |
| changed_by | uuid | YES |
| changed_at | timestamp with time zone | NO |
| note | text | YES |

## cases
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| case_no | text | YES |
| patient_id | uuid | NO |
| caller_name | text | YES |
| caller_relation | text | YES |
| caller_mobile | text | YES |
| source_channel | text | NO |
| stage | USER-DEFINED | NO |
| priority | text | NO |
| services_requested | text | YES |
| clinical_notes | text | YES |
| preferred_slot | timestamp with time zone | YES |
| booked_slot | timestamp with time zone | YES |
| address | text | YES |
| pincode | text | YES |
| zone_id | uuid | YES |
| owner_id | uuid | YES |
| coordinator_id | uuid | YES |
| subtotal | numeric | NO |
| discount_pct | numeric | NO |
| discount_amount | numeric | NO |
| total | numeric | NO |
| quote_status | text | NO |
| quote_template_id | uuid | YES |
| quote_sent_at | timestamp with time zone | YES |
| booking_confirmed_at | timestamp with time zone | YES |
| service_completed_at | timestamp with time zone | YES |
| amount_collected | numeric | NO |
| payment_status | text | NO |
| report_status | text | NO |
| report_delivered_at | timestamp with time zone | YES |
| feedback_rating | integer | YES |
| feedback_text | text | YES |
| cancel_reason | text | YES |
| reopen_reason | text | YES |
| closed_at | timestamp with time zone | YES |
| closed_by | uuid | YES |
| sla_state | text | NO |
| ai_brief | jsonb | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | NO |
| updated_at | timestamp with time zone | NO |
| branch | text | YES |
| additional_info | text | YES |
| external_ref | text | YES |
| care_type | text | NO |
| hospital_name | text | YES |
| hospital_ward | text | YES |
| treating_doctor | text | YES |
| expected_discharge_on | date | YES |
| spoke_with | text | YES |
| decision_maker_name | text | YES |
| decision_maker_relation | text | YES |
| intake_disposition | text | YES |
| validation_status | text | NO |
| plan_days | integer | NO |
| signoff_at | timestamp with time zone | YES |
| signoff_by_name | text | YES |
| signoff_mode | text | YES |
| signoff_note | text | YES |
| decision_maker_mobile | text | YES |
| hospital_room | text | YES |
| journey_state | USER-DEFINED | NO |
| journey_at | timestamp with time zone | YES |
| assessment_type | text | NO |

## complaints
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| ref_no | text | YES |
| case_id | uuid | YES |
| patient_id | uuid | YES |
| category | text | NO |
| severity | text | NO |
| description | text | NO |
| status | text | NO |
| owner_id | uuid | YES |
| opened_by | uuid | YES |
| opened_at | timestamp with time zone | NO |
| acknowledged_at | timestamp with time zone | YES |
| resolved_at | timestamp with time zone | YES |
| root_cause | text | YES |
| resolution | text | YES |

## deployments
| column | type | nullable |
|---|---|---|
| id | bigint | NO |
| at | timestamp with time zone | NO |
| sha | text | NO |
| subject | text | YES |
| author | text | YES |
| areas | text | YES |
| status | text | NO |
| run_url | text | YES |

## discharge_assessments
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| case_id | uuid | NO |
| nurse_id | uuid | YES |
| status | text | NO |
| scheduled_at | timestamp with time zone | YES |
| visited_at | timestamp with time zone | YES |
| met_doctor | boolean | NO |
| doctor_name | text | YES |
| met_ward_staff | boolean | NO |
| met_family | boolean | NO |
| readiness | text | YES |
| revised_discharge_on | date | YES |
| home_setup_notes | text | YES |
| clinical_summary | text | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | NO |
| updated_at | timestamp with time zone | NO |
| doctor_recommendations | text | YES |
| assessment_type | text | NO |

## escalation_matrix
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| type | text | NO |
| level | integer | NO |
| owner_label | text | NO |
| contact_name | text | YES |
| contact_phone | text | YES |
| contact_email | text | YES |
| target_minutes | integer | YES |

## escalations
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| case_id | uuid | YES |
| complaint_id | uuid | YES |
| type | text | NO |
| level | integer | NO |
| trigger_text | text | NO |
| raised_by | uuid | YES |
| raised_at | timestamp with time zone | NO |
| contacted_name | text | YES |
| contacted_at | timestamp with time zone | YES |
| outcome | text | YES |
| status | text | NO |
| acknowledged_by | uuid | YES |
| acknowledged_at | timestamp with time zone | YES |
| resolved_at | timestamp with time zone | YES |
| auto_raised | boolean | NO |

## inbound_emails
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| message_id | text | YES |
| from_address | text | YES |
| to_address | text | YES |
| subject | text | YES |
| text_body | text | YES |
| patient_id | uuid | YES |
| case_id | uuid | YES |
| received_at | timestamp with time zone | NO |

## integration_settings
| column | type | nullable |
|---|---|---|
| provider | text | NO |
| settings | jsonb | NO |
| updated_at | timestamp with time zone | NO |
| updated_by | uuid | YES |

## interactions
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| case_id | uuid | YES |
| patient_id | uuid | YES |
| channel | text | NO |
| direction | text | NO |
| actor_id | uuid | YES |
| actor_label | text | YES |
| summary | text | NO |
| body | text | YES |
| evidence | text | YES |
| call_id | uuid | YES |
| template_id | uuid | YES |
| occurred_at | timestamp with time zone | NO |
| meta | jsonb | NO |

## mis_snapshots
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| period | text | NO |
| period_start | date | NO |
| period_end | date | NO |
| data | jsonb | NO |
| narrative | text | YES |
| generated_at | timestamp with time zone | NO |

## notifications
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| user_id | uuid | YES |
| role | USER-DEFINED | YES |
| kind | text | NO |
| title | text | NO |
| body | text | YES |
| link | text | YES |
| read_at | timestamp with time zone | YES |
| created_at | timestamp with time zone | NO |

## partner_deployments
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| case_id | uuid | NO |
| referral_id | uuid | NO |
| case_item_id | uuid | YES |
| resource_type | text | NO |
| staff_name | text | YES |
| staff_ref | text | YES |
| shift | text | YES |
| equipment_model | text | YES |
| equipment_serial | text | YES |
| status | text | NO |
| dispatched_at | timestamp with time zone | YES |
| delivered_at | timestamp with time zone | YES |
| installed_at | timestamp with time zone | YES |
| active_from | timestamp with time zone | YES |
| ended_at | timestamp with time zone | YES |
| note | text | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | NO |
| updated_at | timestamp with time zone | NO |
| portal_managed | boolean | NO |
| assigned_staff_id | uuid | YES |
| scheduled_at | timestamp with time zone | YES |
| scheduled_end | timestamp with time zone | YES |
| arrived_at | timestamp with time zone | YES |
| completed_at | timestamp with time zone | YES |
| confirmed_by | text | YES |
| return_confirmed_by | text | YES |
| return_required | boolean | NO |
| setup_required | boolean | NO |
| issue_open | boolean | NO |
| issue_note | text | YES |
| version | integer | NO |

## patients
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| mrn | text | YES |
| full_name | text | NO |
| age | integer | YES |
| gender | text | YES |
| mobile | text | YES |
| alt_mobile | text | YES |
| email | text | YES |
| address | text | YES |
| landmark | text | YES |
| locality | text | YES |
| pincode | text | YES |
| city | text | YES |
| zone_id | uuid | YES |
| lat | double precision | YES |
| lng | double precision | YES |
| consent_verbal_at | timestamp with time zone | YES |
| consent_verbal_call_id | uuid | YES |
| consent_digital_at | timestamp with time zone | YES |
| tags | ARRAY | NO |
| created_by | uuid | YES |
| created_at | timestamp with time zone | NO |
| updated_at | timestamp with time zone | NO |

## payment_schedule
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| case_id | uuid | NO |
| seq | integer | NO |
| label | text | NO |
| due_on | date | NO |
| pct | numeric | NO |
| created_by | uuid | YES |
| created_at | timestamp with time zone | NO |

## payments
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| case_id | uuid | NO |
| amount | numeric | NO |
| mode | text | NO |
| txn_ref | text | YES |
| receipt_no | text | YES |
| collected_by | uuid | YES |
| collected_at | timestamp with time zone | NO |
| gateway_status | text | YES |
| settled_at | timestamp with time zone | YES |
| reconciled | boolean | NO |
| reconciled_at | timestamp with time zone | YES |
| reconciled_by | uuid | YES |
| exception | text | YES |

## profiles
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| full_name | text | NO |
| email | text | YES |
| phone | text | YES |
| role | USER-DEFINED | NO |
| agent_code | text | YES |
| myoperator_user_id | text | YES |
| myoperator_extension | text | YES |
| zone_id | uuid | YES |
| skills | ARRAY | NO |
| on_duty | boolean | NO |
| active | boolean | NO |
| last_seen_at | timestamp with time zone | YES |
| created_at | timestamp with time zone | NO |
| provider_id | uuid | YES |
| available | boolean | NO |
| available_since | timestamp with time zone | YES |
| last_autodial_at | timestamp with time zone | YES |

## provider_fulfilment_events
| column | type | nullable |
|---|---|---|
| id | bigint | NO |
| workspace_id | uuid | NO |
| deployment_id | uuid | NO |
| event_id | uuid | NO |
| action | text | NO |
| from_status | text | YES |
| to_status | text | NO |
| actor_id | uuid | NO |
| payload_hash | text | NO |
| note | text | YES |
| occurred_at | timestamp with time zone | NO |

## provider_rates
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| provider_id | uuid | NO |
| service_id | uuid | NO |
| unit | text | NO |
| rate | numeric | NO |
| tax_basis | text | NO |
| effective_from | date | NO |
| effective_to | date | YES |
| status | text | NO |
| import_id | uuid | YES |
| note | text | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | NO |
| replaced_at | timestamp with time zone | YES |

## providers
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| code | text | NO |
| name | text | NO |
| categories | ARRAY | NO |
| contact_phone | text | YES |
| contact_email | text | YES |
| active | boolean | NO |
| created_at | timestamp with time zone | NO |

## qa_reviews
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| call_id | uuid | NO |
| agent_id | uuid | YES |
| reviewer_id | uuid | YES |
| greeting | integer | YES |
| consent | integer | YES |
| price_accuracy | integer | YES |
| empathy | integer | YES |
| closure | integer | YES |
| total_pct | numeric | YES |
| notes | text | YES |
| coaching_action | text | YES |
| ai_generated | boolean | NO |
| created_at | timestamp with time zone | NO |

## rate_imports
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| content_key | text | NO |
| file_name | text | YES |
| sheet_name | text | YES |
| options | jsonb | NO |
| rows | jsonb | NO |
| summary | jsonb | NO |
| buy_status | text | NO |
| sell_status | text | NO |
| approval_id | uuid | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | NO |
| sell_decided_at | timestamp with time zone | YES |

## samples
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| case_id | uuid | NO |
| barcode | text | NO |
| kind | text | NO |
| collected_at | timestamp with time zone | YES |
| handover_at | timestamp with time zone | YES |
| dispatched_at | timestamp with time zone | YES |
| transport_temp_c | numeric | YES |
| received_at | timestamp with time zone | YES |
| accessioned_at | timestamp with time zone | YES |
| report_released_at | timestamp with time zone | YES |
| delivered_at | timestamp with time zone | YES |
| critical_flag | boolean | NO |
| critical_note | text | YES |
| file_url | text | YES |

## service_price_history
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| service_id | uuid | NO |
| version | integer | YES |
| price | numeric | NO |
| unit | text | NO |
| tax_basis | text | YES |
| effective_from | date | NO |
| status | text | NO |
| source | text | NO |
| approval_id | uuid | YES |
| import_id | uuid | YES |
| approved_by | uuid | YES |
| created_at | timestamp with time zone | NO |
| activated_at | timestamp with time zone | YES |

## services
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| code | text | NO |
| name | text | NO |
| category | text | NO |
| price | numeric | NO |
| tat_hours | integer | YES |
| description | text | YES |
| active | boolean | NO |
| version | integer | NO |
| approved_by | uuid | YES |
| approved_at | timestamp with time zone | YES |
| updated_at | timestamp with time zone | NO |
| unit | text | NO |
| tax_basis | text | YES |

## sla_policies
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| key | text | NO |
| label | text | NO |
| target_minutes | integer | NO |
| escalate_to | USER-DEFINED | NO |
| measured_by | text | YES |
| penalty | boolean | NO |

## sla_timers
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| policy_key | text | NO |
| case_id | uuid | YES |
| complaint_id | uuid | YES |
| callback_id | uuid | YES |
| started_at | timestamp with time zone | NO |
| due_at | timestamp with time zone | NO |
| met_at | timestamp with time zone | YES |
| breached_at | timestamp with time zone | YES |
| status | text | NO |

## staff_sessions
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| supervisor_id | uuid | NO |
| staff_id | uuid | NO |
| created_at | timestamp with time zone | NO |
| expires_at | timestamp with time zone | NO |
| ended_at | timestamp with time zone | YES |

## templates
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| kind | text | NO |
| code | text | NO |
| title | text | NO |
| body | text | NO |
| version | integer | NO |
| status | text | NO |
| provider_template_name | text | YES |
| approved_by | uuid | YES |
| approved_at | timestamp with time zone | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | NO |

## v_access
| column | type | nullable |
|---|---|---|
| id | bigint | YES |
| workspace_id | uuid | YES |
| user_id | uuid | YES |
| action | text | YES |
| entity | text | YES |
| entity_id | text | YES |
| meta | jsonb | YES |
| at | timestamp with time zone | YES |
| user_name | text | YES |
| user_role | USER-DEFINED | YES |
| staff_id | uuid | YES |
| staff_session_id | uuid | YES |

## v_approvals
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| case_id | uuid | YES |
| kind | text | YES |
| title | text | YES |
| payload | jsonb | YES |
| status | text | YES |
| requested_by | uuid | YES |
| requested_at | timestamp with time zone | YES |
| decided_by | uuid | YES |
| decided_at | timestamp with time zone | YES |
| decision_note | text | YES |
| case_no | text | YES |
| requested_by_name | text | YES |
| decided_by_name | text | YES |

## v_assessments
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| case_id | uuid | YES |
| nurse_id | uuid | YES |
| status | text | YES |
| scheduled_at | timestamp with time zone | YES |
| visited_at | timestamp with time zone | YES |
| met_doctor | boolean | YES |
| doctor_name | text | YES |
| met_ward_staff | boolean | YES |
| met_family | boolean | YES |
| readiness | text | YES |
| revised_discharge_on | date | YES |
| home_setup_notes | text | YES |
| clinical_summary | text | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | YES |
| updated_at | timestamp with time zone | YES |
| doctor_recommendations | text | YES |
| assessment_type | text | YES |
| nurse_name | text | YES |
| case_no | text | YES |

## v_assignments
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| case_id | uuid | YES |
| staff_id | uuid | YES |
| task | text | YES |
| status | text | YES |
| assigned_by | uuid | YES |
| assigned_at | timestamp with time zone | YES |
| eta | timestamp with time zone | YES |
| window_start | timestamp with time zone | YES |
| window_end | timestamp with time zone | YES |
| checkin_at | timestamp with time zone | YES |
| checkin_lat | double precision | YES |
| checkin_lng | double precision | YES |
| checkin_distance_m | integer | YES |
| checkout_at | timestamp with time zone | YES |
| checklist | jsonb | YES |
| patient_signoff | boolean | YES |
| backup_for | uuid | YES |
| delay_reason | text | YES |
| staff_name | text | YES |
| staff_phone | text | YES |
| case_no | text | YES |
| booked_slot | timestamp with time zone | YES |
| priority | text | YES |
| stage | USER-DEFINED | YES |
| address | text | YES |
| pincode | text | YES |
| patient_name | text | YES |
| patient_age | integer | YES |
| patient_gender | text | YES |
| landmark | text | YES |
| patient_lat | double precision | YES |
| patient_lng | double precision | YES |
| zone_name | text | YES |
| service_names | text | YES |

## v_audit
| column | type | nullable |
|---|---|---|
| id | bigint | YES |
| workspace_id | uuid | YES |
| table_name | text | YES |
| record_id | uuid | YES |
| action | text | YES |
| changes | jsonb | YES |
| actor_id | uuid | YES |
| at | timestamp with time zone | YES |
| actor_name | text | YES |
| actor_role | USER-DEFINED | YES |
| staff_id | uuid | YES |
| staff_session_id | uuid | YES |

## v_callbacks
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| call_id | uuid | YES |
| reason | text | YES |
| due_at | timestamp with time zone | YES |
| status | text | YES |
| assigned_to | uuid | YES |
| attempts | integer | YES |
| last_attempt_at | timestamp with time zone | YES |
| completed_at | timestamp with time zone | YES |
| created_at | timestamp with time zone | YES |
| patient_id | uuid | YES |
| number | text | YES |
| patient_name | text | YES |
| assignee_name | text | YES |
| open_case_id | uuid | YES |
| next_attempt_at | timestamp with time zone | YES |
| auto_dialled | boolean | YES |

## v_calls
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| provider | text | YES |
| provider_call_id | text | YES |
| session_id | text | YES |
| direction | text | YES |
| customer_number | text | YES |
| did_number | text | YES |
| agent_id | uuid | YES |
| agent_label | text | YES |
| department | text | YES |
| status | text | YES |
| started_at | timestamp with time zone | YES |
| answered_at | timestamp with time zone | YES |
| ended_at | timestamp with time zone | YES |
| ring_seconds | integer | YES |
| talk_seconds | integer | YES |
| has_recording | boolean | YES |
| patient_id | uuid | YES |
| case_id | uuid | YES |
| disposition | text | YES |
| notes | text | YES |
| transcript | text | YES |
| ai_summary | text | YES |
| ai_sentiment | text | YES |
| ai_intent | text | YES |
| ai_extracted | jsonb | YES |
| ai_flags | ARRAY | YES |
| ai_processed_at | timestamp with time zone | YES |
| patient_name | text | YES |
| case_no | text | YES |
| qa_pct | numeric | YES |
| line_label | text | YES |
| ai_status | text | YES |
| ai_error | text | YES |
| ai_attempts | integer | YES |
| ai_started_at | timestamp with time zone | YES |
| live_transcript | text | YES |
| live_transcript_completed_at | timestamp with time zone | YES |
| has_live_transcript | boolean | YES |

## v_cases
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| case_no | text | YES |
| patient_id | uuid | YES |
| caller_name | text | YES |
| caller_relation | text | YES |
| caller_mobile | text | YES |
| source_channel | text | YES |
| stage | USER-DEFINED | YES |
| priority | text | YES |
| services_requested | text | YES |
| clinical_notes | text | YES |
| preferred_slot | timestamp with time zone | YES |
| booked_slot | timestamp with time zone | YES |
| address | text | YES |
| pincode | text | YES |
| zone_id | uuid | YES |
| owner_id | uuid | YES |
| coordinator_id | uuid | YES |
| subtotal | numeric | YES |
| discount_pct | numeric | YES |
| discount_amount | numeric | YES |
| total | numeric | YES |
| quote_status | text | YES |
| quote_template_id | uuid | YES |
| quote_sent_at | timestamp with time zone | YES |
| booking_confirmed_at | timestamp with time zone | YES |
| service_completed_at | timestamp with time zone | YES |
| amount_collected | numeric | YES |
| payment_status | text | YES |
| report_status | text | YES |
| report_delivered_at | timestamp with time zone | YES |
| feedback_rating | integer | YES |
| feedback_text | text | YES |
| cancel_reason | text | YES |
| reopen_reason | text | YES |
| closed_at | timestamp with time zone | YES |
| closed_by | uuid | YES |
| sla_state | text | YES |
| ai_brief | jsonb | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | YES |
| updated_at | timestamp with time zone | YES |
| branch | text | YES |
| additional_info | text | YES |
| external_ref | text | YES |
| care_type | text | YES |
| hospital_name | text | YES |
| hospital_ward | text | YES |
| treating_doctor | text | YES |
| expected_discharge_on | date | YES |
| spoke_with | text | YES |
| decision_maker_name | text | YES |
| decision_maker_relation | text | YES |
| intake_disposition | text | YES |
| validation_status | text | YES |
| plan_days | integer | YES |
| signoff_at | timestamp with time zone | YES |
| signoff_by_name | text | YES |
| signoff_mode | text | YES |
| signoff_note | text | YES |
| decision_maker_mobile | text | YES |
| hospital_room | text | YES |
| journey_state | USER-DEFINED | YES |
| journey_at | timestamp with time zone | YES |
| assessment_type | text | YES |
| patient_name | text | YES |
| patient_age | integer | YES |
| patient_gender | text | YES |
| patient_mobile | text | YES |
| caller_mobile_display | text | YES |
| patient_locality | text | YES |
| patient_landmark | text | YES |
| patient_lat | double precision | YES |
| patient_lng | double precision | YES |
| consent_verbal_at | timestamp with time zone | YES |
| consent_digital_at | timestamp with time zone | YES |
| zone_name | text | YES |
| owner_name | text | YES |
| owner_code | text | YES |
| coordinator_name | text | YES |
| service_names | text | YES |
| service_categories | text | YES |
| next_sla_due | timestamp with time zone | YES |
| next_sla_key | text | YES |
| open_escalations | bigint | YES |
| open_complaints | bigint | YES |
| provider_names | text | YES |
| providers_status | jsonb | YES |
| items_recommended | bigint | YES |
| items_agreed | bigint | YES |
| decision_maker_mobile_display | text | YES |

## v_complaints
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| ref_no | text | YES |
| case_id | uuid | YES |
| patient_id | uuid | YES |
| category | text | YES |
| severity | text | YES |
| description | text | YES |
| status | text | YES |
| owner_id | uuid | YES |
| opened_by | uuid | YES |
| opened_at | timestamp with time zone | YES |
| acknowledged_at | timestamp with time zone | YES |
| resolved_at | timestamp with time zone | YES |
| root_cause | text | YES |
| resolution | text | YES |
| case_no | text | YES |
| patient_name | text | YES |
| owner_name | text | YES |
| resolve_due | timestamp with time zone | YES |

## v_deployments
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| case_id | uuid | YES |
| referral_id | uuid | YES |
| case_item_id | uuid | YES |
| resource_type | text | YES |
| staff_name | text | YES |
| staff_ref | text | YES |
| shift | text | YES |
| equipment_model | text | YES |
| equipment_serial | text | YES |
| status | text | YES |
| dispatched_at | timestamp with time zone | YES |
| delivered_at | timestamp with time zone | YES |
| installed_at | timestamp with time zone | YES |
| active_from | timestamp with time zone | YES |
| ended_at | timestamp with time zone | YES |
| note | text | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | YES |
| updated_at | timestamp with time zone | YES |
| provider_code | text | YES |
| provider_name | text | YES |
| case_no | text | YES |
| service_name | text | YES |
| service_code | text | YES |
| item_qty | integer | YES |

## v_escalations
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| case_id | uuid | YES |
| complaint_id | uuid | YES |
| type | text | YES |
| level | integer | YES |
| trigger_text | text | YES |
| raised_by | uuid | YES |
| raised_at | timestamp with time zone | YES |
| contacted_name | text | YES |
| contacted_at | timestamp with time zone | YES |
| outcome | text | YES |
| status | text | YES |
| acknowledged_by | uuid | YES |
| acknowledged_at | timestamp with time zone | YES |
| resolved_at | timestamp with time zone | YES |
| auto_raised | boolean | YES |
| case_no | text | YES |
| patient_name | text | YES |
| raised_by_name | text | YES |

## v_patients
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| mrn | text | YES |
| full_name | text | YES |
| age | integer | YES |
| gender | text | YES |
| mobile | text | YES |
| alt_mobile | text | YES |
| email | text | YES |
| address | text | YES |
| landmark | text | YES |
| locality | text | YES |
| pincode | text | YES |
| city | text | YES |
| zone_id | uuid | YES |
| lat | double precision | YES |
| lng | double precision | YES |
| consent_verbal_at | timestamp with time zone | YES |
| consent_digital_at | timestamp with time zone | YES |
| tags | ARRAY | YES |
| created_at | timestamp with time zone | YES |
| updated_at | timestamp with time zone | YES |
| zone_name | text | YES |
| case_count | bigint | YES |
| last_case_at | timestamp with time zone | YES |
| lifetime_value | numeric | YES |

## v_payment_schedule
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| case_id | uuid | YES |
| seq | integer | YES |
| label | text | YES |
| due_on | date | YES |
| pct | numeric | YES |
| amount | numeric | YES |
| cumulative_due | numeric | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | YES |
| status | text | YES |

## v_referrals
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| workspace_id | uuid | YES |
| case_id | uuid | YES |
| provider_id | uuid | YES |
| categories | ARRAY | YES |
| status | text | YES |
| auto | boolean | YES |
| assigned_to | uuid | YES |
| scheduled_at | timestamp with time zone | YES |
| accepted_at | timestamp with time zone | YES |
| started_at | timestamp with time zone | YES |
| completed_at | timestamp with time zone | YES |
| decline_reason | text | YES |
| last_note | text | YES |
| created_by | uuid | YES |
| created_at | timestamp with time zone | YES |
| updated_at | timestamp with time zone | YES |
| dispatched_at | timestamp with time zone | YES |
| provider_code | text | YES |
| provider_name | text | YES |
| case_no | text | YES |
| case_stage | USER-DEFINED | YES |
| priority | text | YES |
| branch | text | YES |
| services_requested | text | YES |
| additional_info | text | YES |
| clinical_notes | text | YES |
| preferred_slot | timestamp with time zone | YES |
| address | text | YES |
| pincode | text | YES |
| case_created_at | timestamp with time zone | YES |
| patient_id | uuid | YES |
| patient_name | text | YES |
| patient_age | integer | YES |
| patient_gender | text | YES |
| patient_mobile | text | YES |
| caller_mobile | text | YES |
| caller_name | text | YES |
| caller_relation | text | YES |
| landmark | text | YES |
| locality | text | YES |
| assigned_name | text | YES |
| service_names | text | YES |
| care_type | text | YES |
| hospital_name | text | YES |
| hospital_ward | text | YES |
| expected_discharge_on | date | YES |
| plan_days | integer | YES |
| signoff_at | timestamp with time zone | YES |
| fulfilment_managed | boolean | YES |

## v_whatsapp_chats
| column | type | nullable |
|---|---|---|
| id | uuid | YES |
| patient_id | uuid | YES |
| workspace_id | uuid | YES |
| patient_name | text | YES |
| patient_mrn | text | YES |
| patient_mobile | text | YES |
| patient_locality | text | YES |
| patient_pincode | text | YES |
| patient_address | text | YES |
| case_id | uuid | YES |
| case_no | text | YES |
| case_stage | USER-DEFINED | YES |
| priority | text | YES |
| branch | text | YES |
| services_requested | text | YES |
| sla_state | text | YES |
| owner_id | uuid | YES |
| owner_name | text | YES |
| next_sla_due | timestamp with time zone | YES |
| next_sla_key | text | YES |
| last_message_id | uuid | YES |
| last_message_at | timestamp with time zone | YES |
| last_direction | text | YES |
| last_summary | text | YES |
| last_body | text | YES |
| last_actor | text | YES |
| last_status | text | YES |
| last_inbound_at | timestamp with time zone | YES |
| last_outbound_at | timestamp with time zone | YES |
| window_open | boolean | YES |
| needs_reply | boolean | YES |
| inbound_count | integer | YES |
| outbound_count | integer | YES |
| message_count | integer | YES |

## webhook_events
| column | type | nullable |
|---|---|---|
| event_id | text | NO |
| source | text | NO |
| event_type | text | YES |
| received_at | timestamp with time zone | NO |
| processed | boolean | NO |
| error | text | YES |
| payload | jsonb | YES |

## workspaces
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| code | text | NO |
| name | text | NO |
| brand_name | text | NO |
| support_number | text | YES |
| support_email | text | YES |
| timezone | text | NO |
| discount_band_pct | numeric | NO |
| settings | jsonb | NO |
| created_at | timestamp with time zone | NO |

## zones
| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| workspace_id | uuid | NO |
| name | text | NO |
| pincodes | ARRAY | NO |
| active | boolean | NO |
