/**
 * Day-of crew changes: "put Kevin and Tom on Urbanski today", "move Ryan to
 * the Blom job tomorrow", "push Thomason to Friday".
 *
 * Plan first (pure), write only when every change resolves to exactly one
 * person / visit. Nothing is written if any change is ambiguous.
 */
import {
  listUsers,
  listVisitsForDay,
  searchJobs,
  setVisitCrew,
  rescheduleVisit,
  createVisit,
  todayLocal,
} from '../../jobber/client.js';

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "today" | "tomorrow" | weekday name (next occurrence, today counts) | YYYY-MM-DD */
export function resolveDate(input, today) {
  const s = norm(input);
  if (!s || s === 'today') return today;
  if (s === 'tomorrow') return addDays(today, 1);
  if (/^\d{4} \d{2} \d{2}$/.test(s)) return s.replace(/ /g, '-');
  const wd = WEEKDAYS.findIndex((w) => w.startsWith(s.slice(0, 3)) && s.length >= 3);
  if (wd >= 0) {
    const cur = new Date(`${today}T12:00:00Z`).getUTCDay();
    return addDays(today, (wd - cur + 7) % 7);
  }
  throw new Error(`Unrecognized date "${input}" (use today, tomorrow, a weekday, or YYYY-MM-DD)`);
}

export function resolvePerson(name, users) {
  const n = norm(name);
  const exact = users.filter((u) => norm(u.name) === n);
  if (exact.length === 1) return { user: exact[0] };
  const byPart = users.filter(
    (u) => norm(u.firstName) === n || norm(u.lastName) === n || norm(u.name).split(' ').includes(n)
  );
  if (byPart.length === 1) return { user: byPart[0] };
  const prefix = users.filter((u) => norm(u.name).startsWith(n));
  if (!byPart.length && prefix.length === 1) return { user: prefix[0] };
  const candidates = (byPart.length ? byPart : prefix).map((u) => u.name);
  return {
    problem: candidates.length
      ? `"${name}" matches more than one person: ${candidates.join(', ')}`
      : `No active Jobber user named "${name}" (team: ${users.map((u) => u.name).join(', ')})`,
  };
}

export function resolveVisit(jobRef, visits) {
  const ref = String(jobRef || '').trim();
  const n = norm(ref);
  const byId = visits.filter((v) => v.id === ref);
  if (byId.length === 1) return { visit: byId[0] };
  const num = ref.replace(/^#/, '');
  const byNumber = visits.filter((v) => String(v.jobNumber) === num);
  if (byNumber.length === 1) return { visit: byNumber[0] };
  const hay = (v) => norm(`${v.clientName} ${v.jobTitle} ${v.title} ${v.address}`);
  const hits = visits.filter((v) => n && n.split(' ').every((w) => hay(v).includes(w)));
  if (hits.length === 1) return { visit: hits[0] };
  if (hits.length > 1) {
    return {
      problem: `"${jobRef}" matches ${hits.length} visits: ${hits
        .map((v) => `#${v.jobNumber} ${v.clientName}`)
        .join('; ')} — use the job number`,
    };
  }
  return { notFound: true };
}

const crewNames = (crew) => crew.map((c) => c.name).join(', ') || '(nobody)';

/**
 * Pure planner. visitsByDate: { 'YYYY-MM-DD': visits[] }.
 * Each change: { job, people?, mode?: set|add|remove, exclusive?, moveTo?, startTime?, endTime? }
 */
export function planCrewChanges({ date, changes = [], users = [], visitsByDate = {} }) {
  const steps = [];
  const problems = [];
  const visits = visitsByDate[date] || [];
  const crewState = new Map(visits.map((v) => [v.id, v.crew.map((c) => ({ ...c }))]));

  changes.forEach((change, i) => {
    const label = `change ${i + 1} (${change.job || '?'})`;
    const people = [];
    for (const name of change.people || []) {
      const r = resolvePerson(name, users);
      if (r.problem) problems.push(`${label}: ${r.problem}`);
      else people.push({ id: r.user.id, name: r.user.name });
    }

    const vr = resolveVisit(change.job, visits);
    if (vr.problem) {
      problems.push(`${label}: ${vr.problem}`);
      return;
    }
    if (vr.notFound) {
      if (change.createVisitIfMissing) {
        steps.push({ kind: 'create_visit', job: change.job, date, crew: people });
      } else {
        problems.push(
          `${label}: no visit on ${date} matches "${change.job}"` +
            (visits.length
              ? ` (that day: ${visits.map((v) => `#${v.jobNumber} ${v.clientName}`).join('; ')})`
              : ' (nothing scheduled that day)') +
            ' — set createVisitIfMissing to add one'
        );
      }
      return;
    }

    const visit = vr.visit;
    if (people.length) {
      const before = crewState.get(visit.id) || [];
      const ids = new Set(people.map((p) => p.id));
      const mode = change.mode || 'add';
      let after;
      if (mode === 'set') after = people;
      else if (mode === 'remove') after = before.filter((c) => !ids.has(c.id));
      else after = [...before, ...people.filter((p) => !before.some((c) => c.id === p.id))];
      crewState.set(visit.id, after);
      steps.push({
        kind: 'set_crew',
        visitId: visit.id,
        visit: `#${visit.jobNumber} ${visit.clientName}`,
        before: crewNames(before),
        after: crewNames(after),
        assignedUserIds: after.map((c) => c.id),
      });

      if (change.exclusive && mode !== 'remove') {
        for (const other of visits) {
          if (other.id === visit.id) continue;
          const cur = crewState.get(other.id) || [];
          const kept = cur.filter((c) => !ids.has(c.id));
          if (kept.length !== cur.length) {
            crewState.set(other.id, kept);
            steps.push({
              kind: 'set_crew',
              visitId: other.id,
              visit: `#${other.jobNumber} ${other.clientName}`,
              before: crewNames(cur),
              after: crewNames(kept),
              assignedUserIds: kept.map((c) => c.id),
            });
          }
        }
      }
    }

    if (change.moveTo) {
      steps.push({
        kind: 'reschedule',
        visitId: visit.id,
        visit: `#${visit.jobNumber} ${visit.clientName}`,
        from: date,
        to: change.moveTo,
        startTime: change.startTime || null,
        endTime: change.endTime || null,
      });
    }
  });

  // Collapse repeated crew edits on the same visit to the final state.
  const last = new Map();
  steps.forEach((s, idx) => {
    if (s.kind === 'set_crew') last.set(s.visitId, idx);
  });
  const firstBefore = new Map();
  for (const s of steps) {
    if (s.kind === 'set_crew' && !firstBefore.has(s.visitId)) firstBefore.set(s.visitId, s.before);
  }
  const collapsed = steps
    .filter((s, idx) => s.kind !== 'set_crew' || last.get(s.visitId) === idx)
    .map((s) => (s.kind === 'set_crew' ? { ...s, before: firstBefore.get(s.visitId) } : s))
    .filter((s) => s.kind !== 'set_crew' || s.before !== s.after);

  return { steps: collapsed, problems };
}

/** MCP entry: view a day, or plan/apply crew changes. */
export async function runCrewSchedule(args = {}) {
  const today = todayLocal();
  const date = resolveDate(args.date, today);
  const changes = (Array.isArray(args.changes) ? args.changes : []).map((c) => ({
    ...c,
    moveTo: c.moveTo ? resolveDate(c.moveTo, today) : undefined,
  }));

  const [users, day] = await Promise.all([listUsers(), listVisitsForDay({ date })]);
  const schedule = day.visits.map((v) => ({
    visitId: v.id,
    job: `#${v.jobNumber} ${v.jobTitle || v.title || ''}`.trim(),
    client: v.clientName,
    address: v.address,
    time: v.allDay ? 'all day' : v.startAt,
    crew: crewNames(v.crew),
    status: v.status,
  }));

  if (!changes.length) {
    return { date, schedule, team: users.map((u) => u.name) };
  }

  const { steps, problems } = planCrewChanges({
    date,
    changes,
    users,
    visitsByDate: { [date]: day.visits },
  });

  if (problems.length || !args.apply) {
    return {
      applied: false,
      date,
      plan: steps,
      problems,
      schedule,
      hint: problems.length
        ? 'Nothing was changed. Fix the problems (use job numbers / full names) and call again.'
        : 'Plan only. Call again with apply:true to make these changes in Jobber.',
    };
  }

  const results = [];
  for (const step of steps) {
    try {
      if (step.kind === 'set_crew') {
        const r = await setVisitCrew({ visitId: step.visitId, assignedUserIds: step.assignedUserIds });
        results.push({ ...step, ok: true, crewNow: crewNames(r.crew) });
      } else if (step.kind === 'reschedule') {
        const r = await rescheduleVisit({
          visitId: step.visitId,
          date: step.to,
          startTime: step.startTime,
          endTime: step.endTime,
        });
        results.push({ ...step, ok: true, startAt: r.startAt, endAt: r.endAt });
      } else if (step.kind === 'create_visit') {
        const jobs = await searchJobs({ query: step.job, limit: 10 });
        const active = jobs.filter((j) => !/archived|requires_invoicing|complete/i.test(String(j.status)));
        if (active.length !== 1) {
          results.push({
            ...step,
            ok: false,
            error: `Found ${active.length} open jobs for "${step.job}": ${active
              .map((j) => `#${j.jobNumber} ${j.clientName}`)
              .join('; ')} — use the job number`,
          });
          continue;
        }
        const v = await createVisit({
          jobId: active[0].jobId,
          startAt: `${step.date}T14:00:00Z`,
          allDay: true,
          assignedUserIds: step.crew.map((c) => c.id),
        });
        results.push({ ...step, ok: true, visitId: v.id, jobNumber: active[0].jobNumber });
      }
    } catch (err) {
      results.push({ ...step, ok: false, error: err.message });
    }
  }

  return {
    applied: true,
    date,
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}
