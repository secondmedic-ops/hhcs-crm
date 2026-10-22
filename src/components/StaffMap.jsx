// Interactive real-time Field Staff Map (Hinduja Home Care Services)
// 100% Free Forever: Powered by Leaflet & OpenStreetMap (OSM)
// Zero API keys required, zero billing, zero risk of charges now or in future.
// Includes live GPS telemetry, custom DivIcon pins, trajectory lines, geofence indicators, and fallback vector radar.
import { useState, useMemo, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ago, time, date } from '../lib/fmt.js';
import { Badge, Button } from './ui.jsx';
import Icon from './icons.jsx';

const STATUS_STYLE = {
  assigned: { label: 'Assigned', color: '#0284c7', dot: '#0284c7' },
  en_route: { label: 'En route', color: '#d97706', dot: '#d97706' },
  checked_in: { label: 'On site', color: '#0d9488', dot: '#0d9488' },
  on_site: { label: 'On site', color: '#0d9488', dot: '#0d9488' },
  completed: { label: 'Completed', color: '#16a34a', dot: '#16a34a' },
  late: { label: 'Late', color: '#dc2626', dot: '#dc2626' },
};

// MMR reference landmarks for vector radar
const MMR_LANDMARKS = [
  ['Colaba · S. Mumbai', 18.91, 72.825],
  ['Mahim–Dadar', 19.024, 72.843],
  ['Bandra–Khar', 19.064, 72.836],
  ['Andheri', 19.119, 72.846],
  ['Powai', 19.118, 72.906],
  ['Thane', 19.2, 72.972],
  ['Navi Mumbai (Vashi)', 19.077, 72.998],
];

const initials = (name) =>
  (name || 'FS')
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

export default function StaffMap({
  staffLocations = [],
  visits = [],
  now = Date.now(),
  onOpenCase,
  height = 400,
}) {
  const [mode, setMode] = useState('street'); // 'street' (OpenStreetMap) | 'radar' (Vector)
  const [viewFilter, setViewFilter] = useState('all'); // 'all' | 'staff' | 'visits'
  const [selected, setSelected] = useState(null);
  const [zoomLevel, setZoomLevel] = useState(1);

  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const layerGroupRef = useRef(null);

  // Filter valid coordinates
  const staffPts = useMemo(
    () =>
      staffLocations.filter(
        (l) =>
          l.lat != null &&
          l.lng != null &&
          !Number.isNaN(Number(l.lat)) &&
          !Number.isNaN(Number(l.lng))
      ),
    [staffLocations]
  );

  const visitPts = useMemo(
    () =>
      visits.filter(
        (v) =>
          v.patient_lat != null &&
          v.patient_lng != null &&
          !Number.isNaN(Number(v.patient_lat)) &&
          !Number.isNaN(Number(v.patient_lng))
      ),
    [visits]
  );

  // Initialize Leaflet OpenStreetMap
  useEffect(() => {
    if (mode !== 'street' || !mapContainerRef.current) return;

    if (!mapInstanceRef.current) {
      const map = L.map(mapContainerRef.current, {
        center: [19.076, 72.8777], // Mumbai MMR
        zoom: 11,
        zoomControl: true,
        attributionControl: true,
      });

      // Free OpenStreetMap tile server (zero cost, zero API keys forever)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      }).addTo(map);

      const layer = L.layerGroup().addTo(map);
      layerGroupRef.current = layer;
      mapInstanceRef.current = map;
    }

    // Ensure map tiles render correctly on mount/unhide
    const timer = setTimeout(() => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.invalidateSize();
      }
    }, 100);

    return () => {
      clearTimeout(timer);
    };
  }, [mode]);

  // Clean up Leaflet instance when leaving street mode or unmounting
  useEffect(() => {
    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        layerGroupRef.current = null;
      }
    };
  }, []);

  // Update markers, trajectories, and bounds on OpenStreetMap
  useEffect(() => {
    if (mode !== 'street' || !mapInstanceRef.current || !layerGroupRef.current) return;

    const layer = layerGroupRef.current;
    layer.clearLayers();

    const boundsPoints = [];

    // Render Trajectory Lines from en-route staff to patient
    if (viewFilter !== 'visits') {
      staffPts.forEach((l) => {
        if (l.patient_lat != null && l.patient_lng != null) {
          const p1 = [Number(l.lat), Number(l.lng)];
          const p2 = [Number(l.patient_lat), Number(l.patient_lng)];
          if (!Number.isNaN(p1[0]) && !Number.isNaN(p1[1]) && !Number.isNaN(p2[0]) && !Number.isNaN(p2[1])) {
            L.polyline([p1, p2], {
              color: '#0284c7',
              weight: 2.5,
              opacity: 0.85,
              dashArray: '5, 5',
            }).addTo(layer);
          }
        }
      });
    }

    // Render Field Staff Markers
    if (viewFilter !== 'visits') {
      staffPts.forEach((staff) => {
        const lat = Number(staff.lat);
        const lng = Number(staff.lng);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return;

        boundsPoints.push([lat, lng]);

        const isEnRoute = staff.assignment_status === 'en_route';
        const isOnSite = ['checked_in', 'on_site'].includes(staff.assignment_status);
        const isAssigned = staff.assignment_status === 'assigned';
        const bg = isEnRoute
          ? '#d97706'
          : isOnSite
          ? '#0d9488'
          : isAssigned
          ? '#0284c7'
          : '#0f172a';

        const pulseHtml =
          isEnRoute || isOnSite
            ? `<div style="position:absolute; width:34px; height:34px; border-radius:50%; border:2px solid ${bg}; animation:gmp-pulse 2s infinite ease-out; pointer-events:none; top:-7px; left:-7px;"></div>`
            : '';

        const batteryHtml =
          staff.battery_pct != null && staff.battery_pct <= 20
            ? '<span style="color:#ef4444; font-size:9px;">●</span>'
            : '';

        const icon = L.divIcon({
          className: 'custom-staff-marker',
          html: `
            <div style="position:relative; display:flex; align-items:center; justify-content:center;">
              ${pulseHtml}
              <div style="background:${bg}; color:#ffffff; font-weight:700; font-size:11px; font-family:monospace; padding:3px 6px; border-radius:3px; border:1.5px solid #ffffff; box-shadow:0 2px 6px rgba(0,0,0,0.3); display:flex; align-items:center; gap:3px; cursor:pointer;">
                <span>${initials(staff.staff_name)}</span>
                ${batteryHtml}
              </div>
            </div>
          `,
          iconSize: [32, 22],
          iconAnchor: [16, 11],
          popupAnchor: [0, -12],
        });

        const marker = L.marker([lat, lng], { icon, title: staff.staff_name });

        const popupHtml = `
          <div style="font-family: inherit; font-size: 12px; color: #0f172a; min-width: 180px; max-width: 230px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <strong style="font-size:13px;">${staff.staff_name}</strong>
              <span style="font-size:10px; padding:1px 5px; border-radius:3px; background:${isEnRoute ? '#fef3c7' : '#e0f2fe'}; color:${isEnRoute ? '#92400e' : '#0369a1'}; font-weight:600;">
                ${staff.assignment_status || 'Active'}
              </span>
            </div>
            <div style="font-size:11px; color:#64748b; margin-bottom:4px;">
              ${staff.battery_pct != null ? `${staff.battery_pct}% batt · ` : ''}
              ${staff.speed > 0 ? `${Math.round(staff.speed * 3.6)} km/h · ` : ''}
              ${staff.recorded_at ? ago(staff.recorded_at, now) : ''}
            </div>
            ${staff.case_no ? `
              <div style="font-size:11px; padding:4px 6px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:3px; margin-top:2px;">
                <div>Visit: <strong>${staff.case_no}</strong></div>
                <div style="color:#475569;">${staff.patient_name || 'Patient'}</div>
                ${staff.distance_to_patient_m != null ? `
                  <div style="color:#0284c7; margin-top:2px; font-weight:500;">
                    ${staff.distance_to_patient_m <= 200 ? `Within geofence (${staff.distance_to_patient_m}m)` : `${(staff.distance_to_patient_m / 1000).toFixed(1)} km to patient`}
                  </div>
                ` : ''}
              </div>
            ` : ''}
            <div style="margin-top:6px; display:flex; gap:4px; flex-wrap:wrap;">
              <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noreferrer" style="display:inline-block; font-size:11px; padding:2px 6px; background:#0284c7; color:#fff; border-radius:3px; text-decoration:none;">
                Google Maps
              </a>
              ${staff.patient_lat != null ? `
                <a href="https://www.google.com/maps/dir/?api=1&origin=${lat},${lng}&destination=${staff.patient_lat},${staff.patient_lng}" target="_blank" rel="noreferrer" style="display:inline-block; font-size:11px; padding:2px 6px; background:#f1f5f9; color:#334155; border-radius:3px; text-decoration:none; border:1px solid #cbd5e1;">
                  Directions
                </a>
              ` : ''}
            </div>
          </div>
        `;

        marker.bindPopup(popupHtml);
        marker.on('click', () => setSelected({ type: 'staff', data: staff }));
        marker.addTo(layer);
      });
    }

    // Render Patient Visit Markers
    if (viewFilter !== 'staff') {
      visitPts.forEach((visit) => {
        const lat = Number(visit.patient_lat);
        const lng = Number(visit.patient_lng);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return;

        boundsPoints.push([lat, lng]);

        const st = STATUS_STYLE[visit.status] || { dot: '#64748b', label: visit.status };
        const icon = L.divIcon({
          className: 'custom-visit-marker',
          html: `
            <div style="width:14px; height:14px; border-radius:50%; background:${st.dot}; border:2px solid #ffffff; box-shadow:0 1px 4px rgba(0,0,0,0.35); cursor:pointer;"></div>
          `,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
          popupAnchor: [0, -8],
        });

        const marker = L.marker([lat, lng], { icon, title: `${visit.case_no} · ${visit.patient_name || 'Patient'}` });

        const popupHtml = `
          <div style="font-family: inherit; font-size: 12px; color: #0f172a; min-width: 170px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <strong style="font-size:13px;">${visit.case_no}</strong>
              <span style="font-size:10px; padding:1px 5px; border-radius:3px; background:#f1f5f9; color:#334155; font-weight:600;">
                ${st.label}
              </span>
            </div>
            <div style="font-size:11px; color:#334155; margin-bottom:2px;">
              ${visit.patient_name || 'Patient'}
            </div>
            <div style="font-size:10px; color:#64748b; margin-bottom:4px;">
              ${visit.zone_name || visit.pincode || 'MMR'} · Slot: ${time(visit.booked_slot)}
            </div>
            <div style="margin-top:6px;">
              <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noreferrer" style="display:inline-block; font-size:11px; padding:2px 6px; background:#0284c7; color:#fff; border-radius:3px; text-decoration:none;">
                Google Maps
              </a>
            </div>
          </div>
        `;

        marker.bindPopup(popupHtml);
        marker.on('click', () => setSelected({ type: 'visit', data: visit }));
        marker.addTo(layer);
      });
    }

    // Auto-fit bounds
    if (boundsPoints.length > 1) {
      mapInstanceRef.current.fitBounds(L.latLngBounds(boundsPoints), { padding: [30, 30] });
    } else if (boundsPoints.length === 1) {
      mapInstanceRef.current.setView(boundsPoints[0], 14);
    }
  }, [mode, staffPts, visitPts, viewFilter, now]);

  // Vector radar coordinate math for fallback mode
  const bounds = useMemo(() => {
    let latMin = 18.90;
    let latMax = 19.32;
    let lngMin = 72.78;
    let lngMax = 73.08;

    const allLats = [
      ...staffPts.map((p) => Number(p.lat)),
      ...visitPts.map((p) => Number(p.patient_lat)),
    ];
    const allLngs = [
      ...staffPts.map((p) => Number(p.lng)),
      ...visitPts.map((p) => Number(p.patient_lng)),
    ];

    if (allLats.length > 0 && allLngs.length > 0) {
      latMin = Math.min(latMin, ...allLats);
      latMax = Math.max(latMax, ...allLats);
      lngMin = Math.min(lngMin, ...allLngs);
      lngMax = Math.max(lngMax, ...allLngs);
    }

    const dLat = Math.max(0.06, latMax - latMin);
    const dLng = Math.max(0.06, lngMax - lngMin);
    const padLat = dLat * 0.08;
    const padLng = dLng * 0.08;

    return {
      lat0: latMin - padLat,
      lat1: latMax + padLat,
      lng0: lngMin - padLng,
      lng1: lngMax + padLng,
    };
  }, [staffPts, visitPts]);

  const W = 360;
  const meanLat = ((bounds.lat0 + bounds.lat1) / 2) * (Math.PI / 180);
  const H = Math.max(
    260,
    Math.round(W * ((bounds.lat1 - bounds.lat0) / ((bounds.lng1 - bounds.lng0) * Math.cos(meanLat))))
  );

  const px = (lng) => ((lng - bounds.lng0) / (bounds.lng1 - bounds.lng0)) * W;
  const py = (lat) => H - ((lat - bounds.lat0) / (bounds.lat1 - bounds.lat0)) * H;
  const clampX = (lng) => Math.max(12, Math.min(W - 12, px(lng)));
  const clampY = (lat) => Math.max(12, Math.min(H - 12, py(lat)));

  const gridLats = useMemo(() => {
    const list = [];
    const step = bounds.lat1 - bounds.lat0 > 0.6 ? 0.1 : 0.05;
    const start = Math.ceil(bounds.lat0 / step) * step;
    for (let l = start; l < bounds.lat1; l += step) list.push(Number(l.toFixed(3)));
    return list;
  }, [bounds]);

  const gridLngs = useMemo(() => {
    const list = [];
    const step = bounds.lng1 - bounds.lng0 > 0.6 ? 0.1 : 0.05;
    const start = Math.ceil(bounds.lng0 / step) * step;
    for (let g = start; g < bounds.lng1; g += step) list.push(Number(g.toFixed(3)));
    return list;
  }, [bounds]);

  const visibleLandmarks = useMemo(
    () =>
      MMR_LANDMARKS.filter(
        ([, lat, lng]) =>
          lat >= bounds.lat0 && lat <= bounds.lat1 && lng >= bounds.lng0 && lng <= bounds.lng1
      ),
    [bounds]
  );

  const primaryLoc = staffPts[0] || (visitPts[0] ? { lat: visitPts[0].patient_lat, lng: visitPts[0].patient_lng } : null);

  return (
    <div className="fd-map col gap-8">
      {/* Map toolbar */}
      <div className="row between wrap gap-8">
        <div className="row gap-4">
          <Button
            size="xs"
            kind={mode === 'street' ? 'primary' : 'ghost'}
            onClick={() => setMode('street')}
            title="Interactive OpenStreetMap (100% Free Forever)"
          >
            Street Map (Free OSM)
          </Button>
          <Button
            size="xs"
            kind={mode === 'radar' ? 'primary' : 'ghost'}
            onClick={() => setMode('radar')}
            title="Vector Radar MMR Map"
          >
            Radar Map
          </Button>

          <span style={{ borderLeft: '1px solid var(--line)', margin: '0 4px', height: 16 }} />

          <Button
            size="xs"
            kind={viewFilter === 'all' ? 'primary' : 'ghost'}
            onClick={() => setViewFilter('all')}
          >
            All ({staffPts.length + visitPts.length})
          </Button>
          <Button
            size="xs"
            kind={viewFilter === 'staff' ? 'primary' : 'ghost'}
            onClick={() => setViewFilter('staff')}
          >
            Field staff ({staffPts.length})
          </Button>
          <Button
            size="xs"
            kind={viewFilter === 'visits' ? 'primary' : 'ghost'}
            onClick={() => setViewFilter('visits')}
          >
            Visits ({visitPts.length})
          </Button>
        </div>

        <div className="row gap-6">
          <Badge kind="ok" title="100% Free OpenStreetMap: No Google API billing, no credit card, no fees forever">
            100% Free Map
          </Badge>
          {primaryLoc && (
            <a
              href={`https://www.google.com/maps?q=${primaryLoc.lat},${primaryLoc.lng}`}
              target="_blank"
              rel="noreferrer"
              className="btn xs ghost"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              title="Open coordinates in external Google Maps navigation app (free)"
            >
              <Icon name="pin" /> Directions
            </a>
          )}
          {mode === 'radar' && (
            <>
              <Button
                size="xs"
                kind="ghost"
                onClick={() => setZoomLevel((z) => Math.min(1.8, z + 0.2))}
                title="Zoom in"
              >
                +
              </Button>
              <Button
                size="xs"
                kind="ghost"
                onClick={() => setZoomLevel((z) => Math.max(0.8, z - 0.2))}
                title="Zoom out"
              >
                –
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Main Street Map (OpenStreetMap / Leaflet) */}
      {mode === 'street' && (
        <div
          className="fd-map-wrap"
          style={{
            height,
            width: '100%',
            position: 'relative',
          }}
        >
          <div
            ref={mapContainerRef}
            style={{
              height: '100%',
              width: '100%',
              zIndex: 1,
            }}
          />
          {!staffPts.length && !visitPts.length && (
            <div
              style={{
                position: 'absolute',
                top: 10,
                right: 10,
                background: 'rgba(255,255,255,0.92)',
                border: '1px solid var(--line)',
                padding: '4px 8px',
                borderRadius: 3,
                fontSize: 11,
                color: 'var(--muted)',
                zIndex: 1000,
                pointerEvents: 'none',
              }}
            >
              Waiting for live GPS pings...
            </div>
          )}
        </div>
      )}

      {/* Fallback Vector Radar Map */}
      {mode === 'radar' && (
        <div
          className="fd-map-wrap"
          style={{
            position: 'relative',
          }}
        >
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            style={{
              maxHeight: height,
              display: 'block',
              transform: zoomLevel !== 1 ? `scale(${zoomLevel})` : undefined,
              transformOrigin: 'center center',
              transition: 'transform 0.2s ease',
            }}
            role="img"
            aria-label="Real-time map of field staff and patient visits"
          >
            <rect x="0" y="0" width={W} height={H} fill="var(--panel-2)" />

            {/* Latitude lines */}
            {gridLats.map((l) => (
              <g key={`lat-${l}`}>
                <line x1="0" x2={W} y1={py(l)} y2={py(l)} stroke="var(--line-2)" strokeWidth="0.8" />
                <text x="3" y={py(l) - 2} fontSize="7" fill="var(--faint)" fontFamily="var(--mono)">
                  {l.toFixed(2)}°N
                </text>
              </g>
            ))}

            {/* Longitude lines */}
            {gridLngs.map((g) => (
              <g key={`lng-${g}`}>
                <line y1="0" y2={H} x1={px(g)} x2={px(g)} stroke="var(--line-2)" strokeWidth="0.8" />
                <text x={px(g) + 2} y={H - 3} fontSize="7" fill="var(--faint)" fontFamily="var(--mono)">
                  {g.toFixed(2)}°E
                </text>
              </g>
            ))}

            {/* Landmark region circles */}
            {visibleLandmarks.map(([n, lat, lng]) => (
              <g key={n}>
                <circle
                  cx={px(lng)}
                  cy={py(lat)}
                  r="18"
                  fill="none"
                  stroke="var(--line)"
                  strokeDasharray="2 2"
                  strokeWidth="0.8"
                />
                <text
                  x={px(lng)}
                  y={py(lat) - 20}
                  fontSize="8"
                  fontWeight="500"
                  fill="var(--faint)"
                  textAnchor="middle"
                  stroke="var(--panel-2)"
                  strokeWidth="2.5"
                  paintOrder="stroke"
                >
                  {n}
                </text>
              </g>
            ))}

            {/* Trajectory lines */}
            {viewFilter !== 'visits' &&
              staffPts.map((l) => {
                if (l.patient_lat == null || l.patient_lng == null) return null;
                const sx = clampX(l.lng);
                const sy = clampY(l.lat);
                const dx = clampX(l.patient_lng);
                const dy = clampY(l.patient_lat);
                return (
                  <g key={`traj-${l.staff_id}`}>
                    <line
                      x1={sx}
                      y1={sy}
                      x2={dx}
                      y2={dy}
                      stroke="var(--info)"
                      strokeWidth="1.4"
                      strokeDasharray="4 3"
                      opacity="0.8"
                    />
                    {l.distance_to_patient_m != null && (
                      <text
                        x={(sx + dx) / 2}
                        y={(sy + dy) / 2 - 4}
                        fontSize="7"
                        fontFamily="var(--mono)"
                        fill="var(--info)"
                        textAnchor="middle"
                        stroke="var(--panel-2)"
                        strokeWidth="2"
                        paintOrder="stroke"
                      >
                        {l.distance_to_patient_m > 1000
                          ? `${(l.distance_to_patient_m / 1000).toFixed(1)}km`
                          : `${l.distance_to_patient_m}m`}
                      </text>
                    )}
                  </g>
                );
              })}

            {/* Patient visit markers */}
            {viewFilter !== 'staff' &&
              visitPts.map((v) => {
                const isSel = selected?.type === 'visit' && selected.data.id === v.id;
                const st = STATUS_STYLE[v.status] || { dot: 'var(--muted)', label: v.status };
                const vx = clampX(v.patient_lng);
                const vy = clampY(v.patient_lat);
                return (
                  <g
                    key={`visit-${v.id}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelected({ type: 'visit', data: v })}
                  >
                    {isSel && (
                      <circle cx={vx} cy={vy} r="10" fill="none" stroke="var(--ink)" strokeWidth="1.5" />
                    )}
                    <circle cx={vx} cy={vy} r="4.5" fill={st.dot} stroke="var(--panel)" strokeWidth="1.2">
                      <title>{`${v.case_no} · ${v.patient_name || 'Patient'} · ${st.label}`}</title>
                    </circle>
                  </g>
                );
              })}

            {/* Staff live markers with radar waves */}
            {viewFilter !== 'visits' &&
              staffPts.map((l) => {
                const sx = clampX(l.lng);
                const sy = clampY(l.lat);
                const isSel = selected?.type === 'staff' && selected.data.staff_id === l.staff_id;
                const isEnRoute = l.assignment_status === 'en_route';
                const isOnSite = ['checked_in', 'on_site'].includes(l.assignment_status);
                const ringColor = isEnRoute ? 'var(--warn)' : isOnSite ? 'var(--accent)' : 'var(--ink)';

                return (
                  <g
                    key={`staff-${l.staff_id}`}
                    transform={`translate(${sx}, ${sy})`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelected({ type: 'staff', data: l })}
                  >
                    <circle cx="0" cy="0" r="8" fill="none" stroke={ringColor} strokeWidth="1.4" opacity="0.7">
                      <animate attributeName="r" values="6;18" dur="2.2s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.8;0" dur="2.2s" repeatCount="indefinite" />
                    </circle>

                    {isSel && (
                      <circle
                        cx="0"
                        cy="0"
                        r="13"
                        fill="none"
                        stroke="var(--ink)"
                        strokeWidth="1.5"
                        strokeDasharray="2 2"
                      />
                    )}

                    <rect
                      x="-9"
                      y="-9"
                      width="18"
                      height="18"
                      rx="2"
                      fill={isEnRoute ? 'var(--warn)' : isOnSite ? 'var(--accent)' : 'var(--ink)'}
                      stroke="var(--panel)"
                      strokeWidth="1.5"
                    />
                    <text
                      x="0"
                      y="3.5"
                      textAnchor="middle"
                      fill="var(--panel)"
                      fontSize="7.5"
                      fontWeight="700"
                      fontFamily="var(--mono)"
                    >
                      {initials(l.staff_name)}
                    </text>

                    {l.battery_pct != null && l.battery_pct <= 20 && (
                      <circle cx="8" cy="-8" r="3" fill="var(--danger)" stroke="var(--panel)" strokeWidth="1" />
                    )}

                    <title>{`${l.staff_name} · Lat ${Number(l.lat).toFixed(4)}, Lng ${Number(l.lng).toFixed(4)} · ${l.assignment_status || 'available'}`}</title>
                  </g>
                );
              })}
          </svg>
        </div>
      )}

      {/* Selected Marker Detail Card */}
      {selected && (
        <div
          className="panel p-10"
          style={{
            border: '1px solid var(--line)',
            background: 'var(--panel)',
            borderRadius: 'var(--r)',
          }}
        >
          {selected.type === 'staff' ? (
            <div className="col gap-6">
              <div className="row between wrap">
                <span className="strong">
                  {selected.data.staff_name} <Badge kind="info">Staff Live GPS</Badge>
                </span>
                <span className="row gap-4">
                  {selected.data.assignment_status && (
                    <Badge
                      kind={
                        selected.data.assignment_status === 'en_route'
                          ? 'warn'
                          : selected.data.assignment_status === 'checked_in'
                          ? 'ok'
                          : 'outline'
                      }
                    >
                      {selected.data.assignment_status}
                    </Badge>
                  )}
                  {selected.data.battery_pct != null && (
                    <Badge kind={selected.data.battery_pct <= 20 ? 'danger' : 'outline'}>
                      {selected.data.battery_pct}% batt
                    </Badge>
                  )}
                </span>
              </div>

              <div className="tiny muted font-mono">
                {Number(selected.data.lat).toFixed(5)}, {Number(selected.data.lng).toFixed(5)}
                {selected.data.accuracy != null && ` · ±${Math.round(selected.data.accuracy)}m accuracy`}
                {selected.data.speed > 0 && ` · ${Math.round(selected.data.speed * 3.6)} km/h`}
                {selected.data.recorded_at && ` · Last ping: ${ago(selected.data.recorded_at, now)}`}
              </div>

              {selected.data.case_no && (
                <div className="small">
                  Visit: <span className="mono strong">{selected.data.case_no}</span> ·{' '}
                  {selected.data.patient_name || 'Patient'}
                  {selected.data.distance_to_patient_m != null && (
                    <span className="warn-text ml-4 font-mono">
                      ({selected.data.distance_to_patient_m <= 200
                        ? `Within geofence (${selected.data.distance_to_patient_m}m)`
                        : `${selected.data.distance_to_patient_m}m to patient`})
                    </span>
                  )}
                </div>
              )}

              <div className="row gap-8 mt-4 wrap">
                <a
                  className="btn xs primary"
                  href={`https://www.google.com/maps?q=${selected.data.lat},${selected.data.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Icon name="pin" /> View Navigation
                </a>

                {selected.data.patient_lat != null && selected.data.patient_lng != null && (
                  <a
                    className="btn xs ghost"
                    href={`https://www.google.com/maps/dir/?api=1&origin=${selected.data.lat},${selected.data.lng}&destination=${selected.data.patient_lat},${selected.data.patient_lng}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <Icon name="pin" /> Directions to patient
                  </a>
                )}

                {selected.data.case_id && onOpenCase && (
                  <Button size="xs" onClick={() => onOpenCase(selected.data.case_id)}>
                    Open Case
                  </Button>
                )}
                <Button size="xs" kind="ghost" onClick={() => setSelected(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          ) : (
            <div className="col gap-6">
              <div className="row between wrap">
                <span className="mono strong">{selected.data.case_no}</span>
                <Badge
                  kind={
                    selected.data.status === 'en_route'
                      ? 'warn'
                      : selected.data.status === 'checked_in'
                      ? 'ok'
                      : 'outline'
                  }
                >
                  {selected.data.status}
                </Badge>
              </div>
              <div className="small">
                {selected.data.patient_name} ·{' '}
                <span className="muted">{selected.data.zone_name || selected.data.pincode || '–'}</span>
              </div>
              <div className="tiny muted">
                Slot: <span className="mono">{time(selected.data.booked_slot)}</span> · Technician:{' '}
                {selected.data.staff_name || 'Unassigned'}
              </div>
              <div className="row gap-8 mt-4 wrap">
                <a
                  className="btn xs primary"
                  href={`https://www.google.com/maps?q=${selected.data.patient_lat},${selected.data.patient_lng}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Icon name="pin" /> Destination Map
                </a>
                {selected.data.case_id && onOpenCase && (
                  <Button size="xs" onClick={() => onOpenCase(selected.data.case_id)}>
                    Open Case
                  </Button>
                )}
                <Button size="xs" kind="ghost" onClick={() => setSelected(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Map Legend */}
      <div className="row wrap tiny muted gap-12 mt-4">
        <span className="row gap-4 strong">
          <span className="dot" style={{ background: '#0f172a' }} />
          Field staff (Live GPS)
        </span>
        <span className="row gap-4">
          <span
            style={{
              borderBottom: '2px solid #0284c7',
              width: 14,
              display: 'inline-block',
            }}
          />
          En-route path
        </span>
        <span className="row gap-4">
          <span className="dot" style={{ background: '#d97706' }} />
          En route
        </span>
        <span className="row gap-4">
          <span className="dot" style={{ background: '#0d9488' }} />
          On site
        </span>
        <span className="row gap-4">
          <span className="dot" style={{ background: '#16a34a' }} />
          Completed
        </span>
      </div>
    </div>
  );
}
