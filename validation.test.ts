import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { affiliationKey, groupProjects, opuSections, projectKey, resolveAffiliationKey, resolveAlias } from '@shared/affiliation'
import { DEFAULT_OPUS, SEED_PROFANITY } from '@shared/seed'
import { CONSENT_TEXT, MESSAGES, affiliationOf, checkFullName, checkProjectName, checkRegistration, matchOpu } from '@shared/validation'
import { pinPolicyError } from '@shared/admin'

const base = { full_name: 'Firdaus Zahin', affiliation_type: 'project' as const, project_name: 'Kasawari CCS', opu: null, consent: true }

describe('registration – full name', () => {
  const ok = (s: string) => checkFullName(s, SEED_PROFANITY).ok

  it('accepts real names (bin/binti, a/l, a/p, apostrophes, hyphens, periods) and trims spaces', () => {
    for (const n of ['Firdaus Zahin', "Nur 'Ain binti Ahmad", 'Ahmad bin Ali', 'Ravi a/l Kumar', 'Devi a/p Muniandy', 'Mary-Ann O’Neil', 'Dr. Siti', 'Rashitah', 'José Núñez', 'Lim Wei Jie'])
      assert.ok(ok(n), n)
    const r = checkFullName('   Siti    Aminah  ')
    assert.ok(r.ok && r.value === 'Siti Aminah')
  })

  it('blocks blank, too short / long, numbers-only, symbols-only, other symbols and offensive entries', () => {
    for (const n of ['', '   ', 'A', 'x'.repeat(61), '12345', '!!!***', '<script>', 'Ali 2', 'Ali@home', 'a/b Test', 'Siti / Ali', '--', "''"]) assert.ok(!ok(n), JSON.stringify(n))
    assert.ok(!ok('b1tch please'))
    assert.ok(ok('x'.repeat(60)))
  })
})

describe('registration – project name and OPU', () => {
  it('project names: 2–80 characters, digits and common punctuation allowed, needs a letter, profanity-filtered', () => {
    const ok = (s: string) => checkProjectName(s, SEED_PROFANITY).ok
    for (const p of ['Kasawari CCS', 'PFLNG 3', 'GT&C (Phase 2)', 'Jerun-2', 'Rosmari/Marjoram', 'Bergading #1']) assert.ok(ok(p), p)
    for (const p of ['', 'A', '123', '--', 'x'.repeat(81), 'babi project', 'Kasawari <b>']) assert.ok(!ok(p), JSON.stringify(p))
    const r = checkProjectName('  Kasawari    CCS ')
    assert.ok(r.ok && r.value === 'Kasawari CCS')
  })

  it('the OPU list is in the required order and matching ignores case and spacing', () => {
    assert.deepEqual(DEFAULT_OPUS, [
      'Downstream - MRCSB',
      'Downstream - PC MTBE',
      'Downstream - PCEPE',
      'Downstream - PCFKSB',
      'Downstream - PCGCo',
      'Downstream - PCMSB',
      'Downstream - PCOGD',
      'Downstream - PDB',
      'Downstream - PETCO',
      'Downstream - PLISB',
      'Downstream - PP(T)SB',
      'Downstream - PRPC Group',
      'Gas & Maritime - MLNG',
      'Gas & Maritime - PGB GPU',
      'PE&T - GPE',
      'PE&T - PDSB',
      'PE&T - PRSB',
      'Upstream - MPM',
      'Upstream - PMA',
      'Upstream - SBA',
      'Upstream - SKA',
      'Others',
    ])
    assert.equal(matchOpu('  gas   &  maritime - mlng ', DEFAULT_OPUS), 'Gas & Maritime - MLNG')
    assert.equal(matchOpu('others', DEFAULT_OPUS), 'Others')
    assert.equal(matchOpu('Upstream', DEFAULT_OPUS), null, 'a group on its own is not an OPU')
    assert.equal(matchOpu('', DEFAULT_OPUS), null)
  })

  it('the picker groups "Group - Name" entries under headings, in list order, with "Others" on its own', () => {
    const sections = opuSections(DEFAULT_OPUS)
    assert.deepEqual(
      sections.map((s) => [s.group, s.items.length]),
      [
        ['Downstream', 12],
        ['Gas & Maritime', 2],
        ['PE&T', 3],
        ['Upstream', 4],
        [null, 1],
      ],
    )
    assert.deepEqual(sections[0].items[10], { value: 'Downstream - PP(T)SB', label: 'PP(T)SB' })
    assert.deepEqual(sections[4].items, [{ value: 'Others', label: 'Others' }])
    assert.deepEqual(opuSections(['Finance', 'Upstream - PMA', 'Others']).map((s) => s.group), [null, 'Upstream'], 'ungrouped entries share one section')
  })
})

describe('registration – whole form', () => {
  const check = (p: Partial<typeof base> & Record<string, unknown>, opts?: { requireConsent?: boolean }) => checkRegistration({ ...base, ...p } as never, DEFAULT_OPUS, SEED_PROFANITY, opts)

  it('Project path: name + project name', () => {
    const r = check({})
    assert.ok(r.ok)
    assert.deepEqual(r.ok && r.value, { full_name: 'Firdaus Zahin', affiliation_type: 'project', project_name: 'Kasawari CCS', opu: null })
    assert.equal(r.ok && affiliationOf(r.value), 'Kasawari CCS')
  })

  it('Business path: name + OPU from the list (any project name sent is ignored)', () => {
    const r = check({ affiliation_type: 'business', project_name: 'leftover', opu: 'downstream - pcmsb' } as never)
    assert.ok(r.ok)
    assert.deepEqual(r.ok && r.value, { full_name: 'Firdaus Zahin', affiliation_type: 'business', project_name: null, opu: 'Downstream - PCMSB' })
  })

  it('reports every problem at once with the exact messages, first problem first', () => {
    const r = checkRegistration({ full_name: '1', affiliation_type: null, project_name: null, opu: null, consent: false }, DEFAULT_OPUS)
    assert.ok(!r.ok)
    assert.equal(!r.ok && r.field, 'full_name')
    assert.deepEqual(!r.ok && r.errors, { full_name: MESSAGES.name, affiliation_type: MESSAGES.affiliation, consent: MESSAGES.consent })
    assert.equal(MESSAGES.name, 'Please enter your full name.')
    assert.equal(MESSAGES.affiliation, 'Please select Project or Business.')
    assert.equal(MESSAGES.project, 'Please enter your project name.')
    assert.equal(MESSAGES.opu, 'Please select your OPU.')
  })

  it('a project name is required for Project, an OPU from the list for Business', () => {
    const p = check({ project_name: ' ' })
    assert.ok(!p.ok && p.field === 'project_name' && p.message === MESSAGES.project)
    const b = check({ affiliation_type: 'business', opu: null } as never)
    assert.ok(!b.ok && b.field === 'opu' && b.message === MESSAGES.opu)
    const unknown = check({ affiliation_type: 'business', opu: 'Retail' } as never)
    assert.ok(!unknown.ok && unknown.field === 'opu')
    const wrongType = check({ affiliation_type: 'department' } as never)
    assert.ok(!wrongType.ok && wrongType.field === 'affiliation_type')
  })

  it('needs PDPA consent (the device-side check can skip it)', () => {
    const r = check({ consent: false })
    assert.ok(!r.ok && r.field === 'consent')
    assert.ok(check({ consent: false }, { requireConsent: false }).ok)
    assert.equal(CONSENT_TEXT, 'I agree my name and project/OPU will be recorded for this event and shown on the leaderboard.')
  })
})

describe('project grouping and identity', () => {
  it('"kasawari", "KASAWARI " and "Kasawari" are one group; "GT & C" equals "GT&C"', () => {
    assert.equal(projectKey('kasawari'), projectKey('KASAWARI '))
    assert.equal(projectKey('GT & C'), projectKey('gt&c'))
    assert.equal(projectKey('Jérun'), 'jerun')
    const groups = groupProjects(
      [
        { name: 'A', project: 'kasawari' },
        { name: 'B', project: 'KASAWARI ' },
        { name: 'C', project: 'Kasawari' },
        { name: 'D', project: 'Kasawari' },
        { name: 'E', project: 'Jerun' },
      ],
      new Map(),
      new Map(),
    )
    const k = groups.find((g) => g.key === 'kasawari')!
    assert.equal(k.label, 'Kasawari', 'most-used spelling wins')
    assert.equal(k.players, 4)
    assert.equal(groups[0].key, 'kasawari', 'biggest group first')
  })

  it('Admin merges move spellings into another group (and survive chains / loops)', () => {
    const aliases = new Map([['kasawari ccs', 'kasawari'], ['ksw', 'kasawari ccs']])
    assert.equal(resolveAlias('ksw', aliases), 'kasawari')
    assert.equal(resolveAlias('loop-a', new Map([['loop-a', 'loop-b'], ['loop-b', 'loop-a']])), 'loop-b')
    const groups = groupProjects(
      [
        { name: 'A', project: 'Kasawari' },
        { name: 'B', project: 'Kasawari CCS' },
        { name: 'C', project: 'KSW' },
      ],
      aliases,
      new Map([['kasawari', 'Kasawari CCS Project']]),
    )
    assert.equal(groups.length, 1)
    assert.equal(groups[0].label, 'Kasawari CCS Project')
    assert.equal(groups[0].players, 3)
    assert.deepEqual(groups[0].merged_keys, ['kasawari ccs', 'ksw'])
  })

  it('best time per player = full name + project group, or full name + OPU (project and OPU never collide)', () => {
    assert.equal(affiliationKey('project', 'Kasawari CCS', null), 'p:kasawari ccs')
    assert.equal(affiliationKey('business', null, 'Finance'), 'o:finance')
    assert.notEqual(affiliationKey('project', 'Finance', null), affiliationKey('business', null, 'Finance'))
    const aliases = new Map([['kasawari ccs', 'kasawari']])
    assert.equal(resolveAffiliationKey('p:kasawari ccs', aliases), 'p:kasawari')
    assert.equal(resolveAffiliationKey('o:kasawari ccs', aliases), 'o:kasawari ccs', 'merges apply to project names only')
  })
})

describe('admin PIN policy', () => {
  it('rejects short, repeated and straight-run PINs', () => {
    assert.ok(pinPolicyError('1234'))
    assert.ok(pinPolicyError('111111'))
    assert.ok(pinPolicyError('123456'))
    assert.ok(pinPolicyError('987654'))
    assert.equal(pinPolicyError('482915'), null)
  })
})
