import { expect, test, type Page } from '@playwright/test';

const frenchMonths = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
/** Choisit une date dans le calendrier français (bouton « Choisir la date de … »), quel que soit le mois affiché à l’ouverture. */
async function pickDate(page: Page, label: string, iso: string) {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  await page.getByRole('button', { name: `Choisir la date de ${label}`, exact: true }).click();
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('grid') });
  const target = year * 12 + month - 1;
  for (let step = 0; step < 240; step += 1) {
    const title = panel.locator('strong');
    // textContent : innerText suit le text-transform CSS (titre en majuscules).
    const current = ((await title.textContent()) ?? '').trim().toLowerCase();
    const [name, shownYear] = current.split(' ');
    const shown = Number(shownYear) * 12 + frenchMonths.indexOf(name!);
    if (shown === target) break;
    await panel.getByRole('button', { name: shown < target ? 'Mois suivant' : 'Mois précédent', exact: true }).click();
    // Attendre le nouveau mois avant de relire le titre, sinon la boucle repart sur l’ancien.
    await expect(title).not.toHaveText(current);
  }
  await panel.getByRole('button', { name: new RegExp(`^\\S+ ${day} ${frenchMonths[month - 1]} ${year}$`) }).click();
}

type Row = Record<string, unknown>;
async function prepare(page: Page) {
  const calls: { path: string; method: string; body: Row; query: URLSearchParams }[] = [];
  const account = { id: 'admin', username: 'admin', first_name: 'Admin', roles: ['admin'], active: true, email: null };
  const base = { section_ids: ['s'], gymnasium_id: 'g', location: '', courts: 1, referent_id: 'admin', direct_edit: false, cancelled: false, version: 1, registration_section_ids: [], registration_team_ids: [], registration_limit: null, registration_count: 0, starts_at: '2026-10-14T16:00:00Z', ends_at: '2026-10-14T18:00:00Z' };
  const events = [
    { ...base, id: 'local', title: 'Entraînement local', kind: 'training', ffvb_match_id: null },
    { ...base, id: 'ffvb', title: 'Match fédéral', kind: 'match', ffvb_match_id: 'm', kickoff_at: '2026-10-14T17:00:00Z' },
    { ...base, id: 'friendly', title: 'Match amical local', kind: 'match', ffvb_match_id: null },
  ];
  const blocks: Row[] = [];
  await page.context().addCookies([{ name: 'lsoc_csrf', value: 'test-csrf', domain: 'localhost', path: '/' }]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const body = (request.postDataJSON() ?? {}) as Row;
    calls.push({ path, method, body, query: url.searchParams });
    const reply = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/auth/me') return reply(account);
    if (path === '/sections') return reply([{ id: 's', name: 'Loisir' }]);
    if (path === '/gymnasiums') return reply([{ id: 'g', name: 'Paré', capacity: 3 }]);
    if (path === '/users') return reply([account]);
    if (path === '/events') return reply(events);
    if (path === '/events/local') return reply(events[0]);
    if (path.endsWith('/registrations')) return reply({ open: false, eligible: false, registrations: [], count: 0, limit: null });
    if (path.endsWith('/history')) return reply([]);
    if (path === '/availability-blocks') {
      if (method === 'POST') {
        expect(request.headers()['x-csrf-token']).toBe('test-csrf');
        const block = { id: 'block', ...body };
        blocks.push(block);
        return reply(block, 201);
      }
      return reply(blocks);
    }
    if (path === '/gymnasiums/g/availability') return reply({ capacity: 3, segments: [{ starts_at: url.searchParams.get('starts_at'), ends_at: url.searchParams.get('ends_at'), occupied: 1, available: 2, excess: 0 }] });
    if (path === '/ffvb/club') return reply({ club_code: '0926620' });
    if (path === '/ffvb/defaults') return reply({ before_minutes: 75, after_minutes: 150, courts: 3 });
    return reply([]);
  });
  return calls;
}

test('les calendriers Du et Au permettent une consultation avec date française et heures complètes', async ({ page }) => {
  const calls = await prepare(page);
  await page.goto('/app/administration?tab=blocks');
  await page.getByLabel('Gymnase à consulter').selectOption('g');
  await pickDate(page, 'Du', '2026-10-20');
  await pickDate(page, 'Au', '2026-10-20');
  await expect(page.getByLabel('Du (Europe/Paris)', { exact: true })).toHaveValue('20/10/2026');
  await expect(page.getByLabel('Au (Europe/Paris)', { exact: true })).toHaveValue('20/10/2026');
  await page.getByLabel('Heure de Du', { exact: true }).selectOption('18');
  await page.getByLabel('Minutes de Du', { exact: true }).selectOption('45');
  await page.getByLabel('Heure de Au', { exact: true }).selectOption('20');
  await page.getByRole('button', { name: 'Consulter', exact: true }).click();
  await expect(page.getByText('1 occupé(s) · 2 disponible(s)', { exact: true })).toBeVisible();
  const call = calls.find((item) => item.path.endsWith('/availability'))!;
  expect(call.query.get('starts_at')).toBe('2026-10-20T16:45:00.000Z');
  expect(call.query.get('ends_at')).toBe('2026-10-20T18:00:00.000Z');
  expect(await page.locator('form').last().evaluate((form: HTMLFormElement) => form.checkValidity())).toBe(true);
  await page.getByRole('button', { name: 'Ajouter une indisponibilité' }).click();
  await page.getByLabel('Motif', { exact: true }).fill('Travaux');
  await page.getByLabel('Gymnase', { exact: true }).selectOption('g');
  await pickDate(page, 'Début', '2026-10-20');
  await page.getByLabel('Heure de Début', { exact: true }).selectOption('19');
  await pickDate(page, 'Fin', '2026-10-20');
  await page.getByLabel('Heure de Fin', { exact: true }).selectOption('21');
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Travaux' })).toBeVisible();
  expect(calls.find((item) => item.path === '/availability-blocks' && item.method === 'POST')?.body).toMatchObject({ starts_at: '2026-10-20T17:00:00.000Z', ends_at: '2026-10-20T19:00:00.000Z' });
});

test('calendrier semaine et mois : couleurs, filtres, sélection et détail conservé', async ({ page }) => {
  await prepare(page);
  await page.goto('/app/planning?semaine=2026-10-12');
  const calendar = page.getByRole('region', { name: 'Calendrier de la semaine' });
  await expect(calendar.getByRole('link', { name: /Entraînement local/ })).toHaveClass(/origin-local/);
  await expect(calendar.getByRole('link', { name: /Match fédéral/ })).toHaveClass(/origin-ffvb/);
  await expect(calendar.getByRole('link', { name: /Match amical local/ })).toHaveClass(/origin-local/);
  await page.getByLabel('Origine des événements').selectOption('ffvb');
  await expect(calendar.getByRole('link', { name: /Match amical local/ })).toHaveCount(0);
  await page.getByLabel('Origine des événements').selectOption('local');
  await expect(calendar.getByRole('link', { name: /Match fédéral/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mois', exact: true }).click();
  const month = page.getByRole('region', { name: 'Calendrier du mois' });
  await month.getByRole('button', { name: 'Mercredi 14 octobre, 2 événements', exact: true }).click();
  await page.locator('.calendar-selected-day').getByRole('link', { name: /Entraînement local/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/origine=local/);
  await expect(page).toHaveURL(/vue=mois/);
});

test('calendrier et formulaire des bornes restent utilisables de 320 à 2560 px', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Matrice exécutée une fois.');
  test.setTimeout(150_000);
  await prepare(page);
  for (const [width, height] of [[320,568],[360,800],[390,844],[430,932],[768,1024],[1024,768],[1440,900],[1920,1080],[2560,1440]] as const) {
    await page.setViewportSize({ width, height });
    for (const view of ['semaine', 'mois']) {
      await page.goto(`/app/planning?semaine=2026-10-12&vue=${view}`);
      await expect(page.getByRole('heading', { name: 'Planning du club' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${view} ${width}px`).toBe(true);
    }
    await page.goto('/app/administration?tab=blocks');
    await page.getByRole('button', { name: 'Ajouter une indisponibilité' }).click();
    await expect(page.getByLabel('Heure de Début', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Bornes ${width}px`).toBe(true);
  }
  for (const [device, viewport] of [['desktop', {width:1440,height:900}], ['mobile', {width:390,height:844}]] as const) {
    await page.setViewportSize(viewport);
    await page.goto('/app/planning?semaine=2026-10-12&vue=mois');
    await page.getByRole('button', { name: 'Mercredi 14 octobre, 3 événements', exact: true }).click();
    await page.screenshot({path:`.cache/previews/calendar-month-${device}.png`,fullPage:true});
    await page.goto('/app/administration?tab=blocks');
    await pickDate(page, 'Du', '2026-10-20');
    await page.screenshot({path:`.cache/previews/french-dates-${device}.png`,fullPage:true});
  }
});
