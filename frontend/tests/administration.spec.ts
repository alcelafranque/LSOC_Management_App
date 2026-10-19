import { expect, test, type Page } from '@playwright/test';

/** Les équipes sont repliées sous leur section (balise details) : on la déplie. */
async function openSection(page: Page, name: string) {
  const section = page.locator('details.admin-section').filter({ has: page.getByRole('heading', { name, exact: true, level: 3 }) });
  if (!(await section.evaluate((node) => (node as HTMLDetailsElement).open))) await section.locator('summary').click();
}

type Row = Record<string, unknown>;
const admin: Row = { id: 'admin-1', first_name: 'Admin', category: 'adult', roles: ['admin'], active: true, email: 'admin@example.org', messaging_allowed: true, followed_email: true, referent_email: true, admin_email: true };
async function prepare(page: Page) {
  let serial = 0;
  const collections: Record<string, Row[]> = {
    '/licenses': [{ user_id: 'admin-1', first_name: 'Admin', username: 'admin', number: 'LIC-2026-000001', status: 'payment_pending', coach_status: 'none', coach: false, updated_at: '2026-10-10T10:00:00Z', teams: [{ team_id: 'team-1', kind: 'player' }], missing: true }], '/users': [admin], '/sections': [{ id: 'section-1', name: 'Compétition' }], '/teams': [{ id: 'team-1', name: 'Compétition A', section_id: 'section-1', referent_id: 'admin-1' }], '/gymnasiums': [{ id: 'gym-1', name: 'Paré', capacity: 3 }], '/availability-blocks': [], '/ffvb/sources': [], '/ffvb/gym-mappings': [], '/ffvb/matches': [{ id: 'match-1', match_code: 'BRC001', season: '2026/2027', official: { location: 'PARÉ' }, protected: { location: 'admin-1' }, disabled: true, missing: false, suspended_until: null, last_verified_at: '2026-10-09T10:00:00Z' }], '/ffvb/conflicts': [{ id: 'conflict-1', match_id: 'match-1', field: 'location', official_value: 'PARÉ', local_value: 'Extérieur', status: 'open', created_at: '2026-10-10T10:00:00Z' }], '/admin/email-jobs': [{ id: 'job-1', user_id: 'admin-1', attempts: 8, due_at: '2026-10-10T10:00:00Z', sent_at: null }], '/change-requests': [{ id: 'request-1', event_id: 'event-1', actor_name: 'Camille', base_version: 1, changes: { title: 'Séance déplacée' }, status: 'pending', decision: '', created_at: '2026-10-10T10:00:00Z' }], '/events': [{ id: 'event-1', title: 'Entraînement du jeudi', version: 1 }],
  };
  const mutations: { path: string; method: string; body: Row }[] = [];
  await page.context().addCookies([{ name: 'lsoc_csrf', value: 'browser-csrf', domain: 'localhost', path: '/' }]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const body = (request.postDataJSON() ?? {}) as Row;
    async function reply(value: unknown, status = 200) { await route.fulfill({ status, contentType: 'application/json', body: status === 204 ? '' : JSON.stringify(value) }); }
    if (path === '/auth/me') return reply(admin);
    if (method !== 'GET') { expect(request.headers()['x-csrf-token']).toBe('browser-csrf'); mutations.push({ path, method, body }); }
    if (path === '/ffvb/defaults') return reply(method === 'GET' ? { before_minutes: 75, after_minutes: 150, courts: 3 } : body);
    if (path === '/ffvb/club') return reply({ club_code: '0926620' });
    if (path === '/ffvb/sources/preview') return reply({ season: '2026/2027', entity: 'PTIDF92', pool: 'BRC', club_code: '0926620', candidates: [{ team_name: 'LSO COLOMBES', team_number: '6', team_id: 'team-1' }], warning: null });
    if (path.endsWith('/ffvb-warning')) { const team = collections['/teams']?.find((item) => path.includes(String(item.id))); if (team) team.ffvb_source_warning_ignored = body.ignored; return reply(team); }
    if (/\/availability$/.test(path)) return reply({ capacity: 3, segments: [{ starts_at: url.searchParams.get('starts_at'), ends_at: url.searchParams.get('ends_at'), occupied: 1, available: 2, excess: 0 }] });
    if (path.endsWith('/retry')) return reply({ ...collections['/admin/email-jobs']?.[0], attempts: 0 });
    if (path.endsWith('/decision')) { const item = collections['/change-requests']?.[0]; if (item) item.status = body.accept ? 'accepted' : 'rejected'; return reply(item); }
    if (path.endsWith('/resolve')) { collections['/ffvb/conflicts'] = []; return reply(collections['/ffvb/matches']?.[0]); }
    if (path.endsWith('/reactivate')) { const item = collections['/ffvb/matches']?.[0]; if (item) item.disabled = false; return reply(item); }
    if (path.endsWith('/sync')) return reply(collections['/ffvb/sources']?.find((source) => path.includes(String(source.id))));
    if (path.includes('/invitation')) {
      if (method === 'DELETE') return reply(undefined, 204);
      const user = collections['/users']?.find((item) => path.includes(String(item.id)));
      return reply({ user, invitation_token: 'new-secret', invitation_url: 'http://localhost:5173/activate?token=new-secret' });
    }
    const base = Object.keys(collections).find((key) => path === key || path.startsWith(`${key}/`)) ?? path;
    const entries = collections[base] ?? [];
    if (path.endsWith('/assignments') || path.includes('/assignments/')) {
      if (method === 'GET') return reply(collections[path] ?? []);
      const assignment = { id: `assignment-${++serial}`, ...body }; collections[path] = [...(collections[path] ?? []), assignment]; return reply(assignment, 201);
    }
    if (method === 'GET') {
      const status = url.searchParams.get('status');
      const filtered = base === '/change-requests' && status ? entries.filter((item) => item.status === status) : entries;
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return reply(filtered.slice(offset, offset + Number(url.searchParams.get('limit') ?? 500)));
    }
    if (method === 'POST') {
      const item: Row = { id: `item-${++serial}`, ...body };
      if (base === '/users') { item.active = false; entries.push(item); return reply({ user: item, invitation_token: 'private-link-token', invitation_url: 'http://localhost:5173/activate?token=private-link-token' }, 201); }
      if (base === '/ffvb/sources') { item.last_success_at = null; item.last_error = null; }
      entries.push(item); collections[base] = entries; return reply(item, 201);
    }
    const identifier = path.split('/').at(-1);
    const item = entries.find((entry) => entry.id === identifier);
    if (method === 'PUT') { Object.assign(item ?? {}, body); return reply(item); }
    if (method === 'DELETE') { collections[base] = entries.filter((entry) => entry.id !== identifier); return reply(undefined, 204); }
    return reply({ detail: 'Route non prévue' }, 404);
  });
  await page.goto('/app/administration');
  await expect(page.getByRole('button', { name: 'Ajouter un utilisateur' })).toBeVisible();
  return { collections, mutations };
}
async function tab(page: Page, name: string) { await page.getByRole('navigation', { name: 'Administration', exact: true }).getByRole('link', { name, exact: true }).click(); }

test('utilisateur, invitation, rôles et rattachement', async ({ page }) => {
  const { mutations } = await prepare(page);
  await page.getByRole('button', { name: 'Ajouter un utilisateur' }).click();
  await page.getByLabel('Prénom', { exact: true }).fill('Mina');
  await page.getByLabel('Nom', { exact: true }).fill('Durand');
  await page.getByRole('checkbox', { name: 'Coach', exact: true }).check();
  await page.getByRole('button', { name: 'Créer et inviter' }).click();
  await expect(page.getByLabel('Lien d’invitation')).toHaveValue(/private-link-token/);
  await page.getByLabel('Équipe', { exact: true }).selectOption('team-1');
  await page.getByLabel('Type de rattachement').selectOption('coach');
  await page.getByRole('button', { name: 'Rattacher', exact: true }).click();
  await expect(page.getByText('Compétition A · Coach', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Régénérer l’invitation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmer', exact: true }).click();
  await expect(page.getByLabel('Lien d’invitation')).toHaveValue(/new-secret/);
  await page.getByRole('button', { name: 'Révoquer l’invitation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmer', exact: true }).click();
  await expect(page.getByLabel('Lien d’invitation')).toHaveCount(0);
  expect(mutations.find((request) => request.path === '/users')?.body.roles).toEqual(['member', 'coach']);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test('création des sections, équipes et gymnases, modification et suppression', async ({ page }) => {
  await prepare(page);
  await tab(page, 'Sections et équipes');
  await page.getByRole('button', { name: 'Ajouter une section' }).click();
  await page.getByLabel('Nom', { exact: true }).fill('Loisir');
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Loisir', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ajouter une équipe', exact: true }).click();
  await page.getByLabel('Nom', { exact: true }).fill('Loisir A');
  await page.getByLabel('Section', { exact: true }).selectOption({ label: 'Loisir' });
  await page.getByLabel('Référent', { exact: true }).selectOption('admin-1');
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await openSection(page, 'Loisir');
  await expect(page.getByRole('heading', { name: 'Loisir A', exact: true })).toBeVisible();
  await tab(page, 'Gymnases');
  await page.getByRole('button', { name: 'Ajouter un gymnase' }).click();
  await page.getByLabel('Nom', { exact: true }).fill('Stade');
  await page.getByLabel('Capacité en terrains').fill('4');
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await page.getByRole('button', { name: 'Modifier Stade', exact: true }).click();
  await page.getByLabel('Capacité en terrains').fill('2');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Stade', exact: true }) })).toContainText('2 terrains');
  await page.getByRole('button', { name: 'Supprimer Stade', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmer la suppression' }).click();
  await expect(page.getByRole('heading', { name: 'Stade', exact: true })).toHaveCount(0);
});

test('indisponibilités et disponibilité en heure de Paris', async ({ page }) => {
  const { mutations } = await prepare(page);
  await tab(page, 'Indisponibilités');
  await page.getByRole('button', { name: 'Ajouter une indisponibilité' }).click();
  await page.getByLabel('Motif', { exact: true }).fill('Travaux');
  await page.getByLabel('Gymnase', { exact: true }).selectOption('gym-1');
  await page.getByLabel('Début (Europe/Paris)').fill('2026-10-20T18:00');
  await page.getByLabel('Fin (Europe/Paris)').fill('2026-10-20T20:00');
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Travaux', exact: true })).toBeVisible();
  expect(mutations.find((item) => item.path === '/availability-blocks')?.body.starts_at).toBe('2026-10-20T16:00:00.000Z');
  await page.getByLabel('Gymnase à consulter').selectOption('gym-1');
  await page.getByLabel('Du (Europe/Paris)').fill('2026-10-20T18:00');
  await page.getByLabel('Au (Europe/Paris)').fill('2026-10-20T20:00');
  await page.getByRole('button', { name: 'Consulter', exact: true }).click();
  await expect(page.getByText('1 occupé(s) · 2 disponible(s)', { exact: true })).toBeVisible();
});

test('sources et associations FFVB, conflits et réactivation', async ({ page }) => {
  const { mutations } = await prepare(page);
  await tab(page, 'FFVB');
  await page.getByRole('button', { name: 'Ajouter une source' }).click();
  await expect(page.getByLabel('Code du club FFVB')).toBeDisabled();
  await expect(page.getByLabel('Fréquence (jours)')).toHaveValue('1');
  await expect(page.getByLabel('Saison', { exact: true })).toHaveValue('2026/2027');
  await page.getByLabel('Équipe locale').selectOption('team-1');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByRole('button', { name: 'Synchroniser', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Synchronisation réussie' })).toContainText('Synchronisation réussie');
  await page.getByRole('button', { name: 'Gymnases FFVB', exact: true }).click();
  await page.getByRole('button', { name: 'Associer un gymnase FFVB' }).click();
  await page.getByLabel('Nom officiel FFVB').fill('GYMNASE AMBROISE PARE');
  await page.getByLabel('Gymnase local').selectOption('gym-1');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'GYMNASE AMBROISE PARE' })).toBeVisible();
  await page.getByRole('button', { name: 'Marges et terrains', exact: true }).click();
  await page.getByLabel('Marge avant le coup d’envoi (minutes)').fill('90');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  expect(mutations.find((item) => item.path === '/ffvb/defaults')?.body).toEqual({ before_minutes: 90, after_minutes: 150, courts: 3 });
  await page.getByRole('button', { name: 'Conflits', exact: true }).click();
  await page.getByRole('button', { name: 'Suspendre 48 h', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmer', exact: true }).click();
  await expect(page.getByText('Aucun conflit FFVB ouvert.')).toBeVisible();
  await page.getByRole('button', { name: 'Matchs importés', exact: true }).click();
  await page.getByRole('button', { name: 'Réactiver', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Réactiver', exact: true })).toHaveCount(0);
});

test('création par URL et avertissement des équipes sans source', async ({ page }) => {
  const { mutations } = await prepare(page);
  await expect(page.getByText('Aucune source FFVB créée pour l’équipe Compétition A.')).toBeVisible();
  await page.getByRole('button', { name: 'Ignorer pour Compétition A' }).click();
  await expect(page.getByText('Aucune source FFVB créée pour l’équipe Compétition A.')).toHaveCount(0);
  await tab(page, 'Sections et équipes');
  await openSection(page, 'Compétition');
  await page.getByRole('button', { name: 'Réactiver l’avertissement pour Compétition A' }).click();
  await expect(page.getByText('Aucune source FFVB créée pour l’équipe Compétition A.')).toBeVisible();
  await tab(page, 'FFVB');
  await page.getByLabel('URL du calendrier FFVB').fill('https://www.ffvbbeach.org/ffvbapp/resu/vbspo_calendrier.php?saison=2026/2027&codent=PTIDF92&poule=BRC');
  await page.getByLabel('Fréquence de la nouvelle source (jours)').fill('7');
  await page.getByRole('button', { name: 'Créer depuis l’URL' }).click();
  await expect(page.getByRole('heading', { name: 'LSO COLOMBES n°6' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Équipes sans source FFVB' })).toHaveCount(0);
  expect(mutations.find((item) => item.path === '/ffvb/sources')?.body.interval_days).toBe(7);
});

test('validation motivée et relance d’un e-mail', async ({ page }) => {
  const { mutations } = await prepare(page);
  await tab(page, 'Validations');
  await page.getByRole('button', { name: 'Examiner', exact: true }).click();
  await page.getByLabel('Décision', { exact: true }).selectOption('no');
  await page.getByLabel('Message au référent').fill('Gymnase fermé');
  await page.getByRole('button', { name: 'Enregistrer la décision' }).click();
  expect(mutations.find((item) => item.path.endsWith('/decision'))?.body).toEqual({ accept: false, reason: 'Gymnase fermé', force: false, acknowledge_ffvb: false });
  await tab(page, 'E-mails');
  await page.getByRole('button', { name: 'Relancer l’envoi' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Envoi relancé' })).toContainText('Envoi relancé');
  expect(mutations.some((item) => item.path === '/admin/email-jobs/job-1/retry')).toBe(true);
});

test('administration utilisable de 320 à 2560 px sans débordement', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Matrice exécutée sur le projet desktop.');
  test.setTimeout(120_000);
  await prepare(page);
  const dimensions = [[320,568],[360,800],[375,667],[390,844],[412,915],[430,932],[768,1024],[820,1180],[1024,768],[1280,720],[1366,768],[1440,900],[1920,1080],[2560,1440]];
  for (const [width, height] of dimensions) {
    await page.setViewportSize({ width: width!, height: height! });
    for (const name of ['Utilisateurs', 'Sections et équipes', 'Licences', 'Postes', 'Gymnases', 'Indisponibilités', 'Validations', 'FFVB', 'E-mails']) {
      await tab(page, name);
      const heading = name === 'Postes' ? 'Postes des joueurs' : name;
      await expect(page.getByRole('heading', { name: heading, exact: true }).last()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}, ${width}px`).toBe(true);
    }
    await tab(page, 'Utilisateurs');
    await page.getByRole('button', { name: 'Ajouter un utilisateur' }).click();
    await expect(page.getByLabel('Prénom', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Formulaire, ${width}px`).toBe(true);
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  }
});
