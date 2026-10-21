import type { Ctx } from '../api/context';
import { asUser } from '../db';
import { ApiError } from '../domain/errors';

export interface PingLocationBody {
  lat: number;
  lng: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  battery_pct?: number | null;
  assignment_id?: string | null;
  case_id?: string | null;
}

export async function pingLocation(c: Ctx, body: PingLocationBody) {
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  if (Number.isNaN(lat) || lat < -90 || lat > 90 || Number.isNaN(lng) || lng < -180 || lng > 180) {
    throw new ApiError(400, 'Valid latitude (-90 to 90) and longitude (-180 to 180) are required');
  }

  const { result: out, changed } = await asUser(c.sql, c.user.id, async (tx) => {
    let caseId = body.case_id || null;
    let autoArrived = false;
    let distanceM: number | null = null;

    if (body.assignment_id) {
      const [asg] = await tx.unsafe(
        `select a.id, a.case_id, a.status, a.eta, a.window_start, a.actual_arrival_at,
                c.booked_slot, pt.lat as pt_lat, pt.lng as pt_lng
         from assignments a
         join cases c on c.id = a.case_id
         join patients pt on pt.id = c.patient_id
         where a.id = $1 and (a.staff_id = $2 or $3 = any(array['supervisor','coordinator']))`,
        [body.assignment_id, c.user.id, c.user.role]
      );
      if (asg) {
        if (!caseId) caseId = asg.case_id;
        if (asg.pt_lat != null && asg.pt_lng != null) {
          const [dRow] = await tx.unsafe(
            `select haversine_m($1, $2, $3, $4) as dist`,
            [Number(asg.pt_lat), Number(asg.pt_lng), lat, lng]
          );
          distanceM = dRow?.dist != null ? Number(dRow.dist) : null;
          // Auto geofence check (200m) while en route
          if (distanceM != null && distanceM <= 200 && !asg.actual_arrival_at && asg.status === 'en_route') {
            const [vRow] = await tx.unsafe(
              `select round(extract(epoch from (now() - coalesce($1::timestamptz, $2::timestamptz, $3::timestamptz))) / 60)::int as var_min`,
              [asg.eta, asg.window_start, asg.booked_slot]
            );
            await tx.unsafe(
              `update assignments set actual_arrival_at = now(), eta_vs_ata_variance_min = $1,
                      status = 'checked_in', checkin_at = coalesce(checkin_at, now()),
                      checkin_lat = $2, checkin_lng = $3, checkin_distance_m = $4
               where id = $5`,
              [vRow?.var_min ?? 0, lat, lng, distanceM, asg.id]
            );
            await tx.unsafe(
              `select log_interaction($1::uuid, 'field', 'internal',
                'Geofence auto-arrival detected · ' || $2 || ' m from pin · ATA recorded',
                null, 'GPS ' || round($3::numeric,5) || ',' || round($4::numeric,5))`,
              [asg.case_id, distanceM, lat, lng]
            );
            autoArrived = true;
          }
        }
      }
    }

    // partner (BMM) field staff send GPS only while their manager has switched live location on (location_allowed);
    // a refused ping rolls back the whole request, geofence arrival included
    const [loc] = await tx.unsafe(
      `insert into staff_locations(workspace_id, staff_id, assignment_id, case_id, lat, lng, accuracy, speed, heading, battery_pct)
       select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::float8, $6::float8, $7::numeric, $8::numeric, $9::numeric, $10::int
       where location_allowed($2::uuid)
       returning id, recorded_at`,
      [
        c.user.workspaceId,
        c.user.id,
        body.assignment_id || null,
        caseId,
        lat,
        lng,
        body.accuracy != null ? Number(body.accuracy) : null,
        body.speed != null ? Number(body.speed) : null,
        body.heading != null ? Number(body.heading) : null,
        body.battery_pct != null ? Math.round(Number(body.battery_pct)) : null,
      ]
    );
    if (!loc) throw new ApiError(403, 'Live location is switched off for your login. Ask your manager to turn it on.');

    return {
      ok: true,
      id: loc.id,
      recorded_at: loc.recorded_at,
      auto_arrived: autoArrived,
      distance_m: distanceM,
    };
  });

  c.changed.push(...changed);
  c.changed.push('staff_locations');
  if (out.auto_arrived) c.changed.push('assignments');

  return out;
}
