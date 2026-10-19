import { expect, test, type Page } from '@playwright/test';

type Row = Record<string, unknown>;
async function prepare(page: Page) {
  let admin = false;
  const requests: Row[] = [];
  const mutations: { path: string; body: Row }[] = [];
  const coach = { id: 'coach', username: 'camille', first_name: 'Camille', roles: ['member', 'coach'], active: true, email: null };
  const accountAdmin = { ...coach, id: 'admin', username: 'admin', first_name: 'Admin', roles: ['admin'] };
  const teams = [{ id: 't1', name: 'Compétition 1', section_id: 's1' }, { id: 't2', name: 'Compétition 2', section_id: 's1' }, { id: 't3', name: 'Loisir 1', section_id: 's2' }];
  await page.context().addCookies([{ name: 'lsoc_csrf', value: 'csrf', domain: 'localhost', path: '/' }]);
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = (req.postDataJSON() ?? {}) as Row;
    const reply = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/auth/me') return reply(admin ? accountAdmin : coach);
    if (path === '/teams') return reply(teams);
    if (path === '/sections') return reply([{ id: 's1', name: 'Compétition' }, { id: 's2', name: 'Loisir' }]);
    if (path === '/gymnasiums') return reply([{ id: 'g', name: 'Paré', capacity: 3 }]);
    if (path === '/users') return reply([accountAdmin, coach]);
    if (path === '/users/coach/assignments') return reply([{ id: 'a1', user_id: 'coach', team_id: 't1', kind: 'coach' }, { id: 'a2', user_id: 'coach', team_id: 't2', kind: 'coach' }]);
    if (path === '/ffvb/club') return reply({ club_code: '0926620' });
    if (path === '/event-requests' && req.method() === 'POST') {
      expect(req.headers()['x-csrf-token']).toBe('csrf');
      mutations.push({ path, body });
      const { team_id, note, ...proposal } = body;
      const result = { id: 'request', team_id, actor_id: 'coach', actor_name: 'Camille', note, proposal: { ...proposal, section_ids: ['s1'], referent_id: 'coach', direct_edit: false }, status: 'pending', created_at: '2026-10-11T12:00:00Z', event_id: null, decision: '' };
      requests.push(result);
      return reply(result, 201);
    }
    if (path === '/event-requests/request/decision') {
      expect(req.headers()['x-csrf-token']).toBe('csrf');
      mutations.push({ path, body });
      Object.assign(requests[0]!, { status: body.accept ? 'accepted' : 'rejected', decision: body.reason, decided_at: '2026-10-11T12:05:00Z', decider_name: 'Admin', event_id: body.accept ? 'created' : null });
      return reply(requests[0]);
    }
    if (path === '/event-requests') return reply(requests.filter((item) => !url.searchParams.get('status') || item.status === url.searchParams.get('status')));
    return reply([]);
  });
  return { mutations, asAdmin: () => { admin = true; } };
}

test('un coach multiéquipes propose une séance ouverte puis l’admin accepte et le coach voit la décision', async ({ page }) => {
  const { mutations, asAdmin } = await prepare(page);
  await page.goto('/app/planning?semaine=2026-10-12');
  await page.getByRole('button', { name: 'Nouvel événement', exact: true }).click();
  const teams = page.getByRole('group', { name: 'Équipes organisatrices', exact: true });
  await expect(teams.getByRole('checkbox')).toHaveCount(3);
  await teams.getByLabel('Compétition 2', { exact: true }).check();
  await page.getByLabel('Titre', { exact: true }).fill('Stage ouvert');
  await page.getByLabel('Gymnase du club', { exact: true }).selectOption('g');
  const open = page.getByRole('group', { name: 'Ouvert aux inscriptions', exact: true });
  await open.getByLabel('Loisir', { exact: true }).check();
  await open.getByLabel('Équipes de Loisir', { exact: true }).click();
  await open.getByLabel('Loisir 1', { exact: true }).check();
  await page.getByRole('button', { name: 'Envoyer la demande', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('maximal');
  expect(mutations).toHaveLength(0);
  await page.getByLabel('Nombre maximal d’inscrits').fill('12');
  await page.getByLabel('Commentaire').fill('Préparation tournoi');
  await page.getByRole('button', { name: 'Envoyer la demande', exact: true }).click();
  const mine = page.getByRole('region', { name: 'Mes demandes d’événements' });
  await expect(mine).toContainText('En attente');
  expect(mutations[0]?.body).toMatchObject({ team_id: 't2', registration_team_ids: ['t3'], registration_section_ids: ['s2'], registration_limit: 12, starts_at: '2026-10-12T16:00:00.000Z', ends_at: '2026-10-12T18:00:00.000Z' });
  expect(mutations[0]?.body).not.toHaveProperty('force');
  expect(mutations[0]?.body).not.toHaveProperty('referent_id');
  asAdmin();
  await page.goto('/app/administration?tab=requests');
  await page.getByRole('button', { name: 'Nouveaux événements', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Stage ouvert' })).toBeVisible();
  await page.getByRole('button', { name: 'Examiner', exact: true }).click();
  await page.getByLabel('Décision', { exact: true }).selectOption('yes');
  await page.getByLabel('Message au référent').fill('Créneau validé');
  await page.getByRole('button', { name: 'Enregistrer la décision', exact: true }).click();
  await expect(page.getByText('Décision enregistrée.', { exact: true })).toBeVisible();
  await page.getByLabel('État des demandes').selectOption('accepted');
  await expect(page.getByRole('link', { name: 'Voir l’événement' })).toHaveAttribute('href', '/app/planning?event=created');
  expect(mutations[1]?.body).toEqual({ accept: true, reason: 'Créneau validé', force: false, acknowledge_ffvb: false });
});

test('le formulaire coach reste contenu sur téléphone, tablette et ordinateur', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Matrice exécutée une fois.');
  await prepare(page);
  for (const [width, height] of [[320,568],[390,844],[768,1024],[1440,900],[2560,1440]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/app/planning?semaine=2026-10-12');
    await page.getByRole('button', { name: 'Nouvel événement', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Équipes organisatrices', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Demande ${width}px`).toBe(true);
  }
});
