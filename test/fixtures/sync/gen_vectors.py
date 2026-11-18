#!/usr/bin/env python3
"""Regenerate test/fixtures/sync/vectors.json from the vault's reference fake.

The vault side of the trip-file sync (`trip_sync.py`) ships an executable reference for the
`wlog sync` contract: `.claude/skills/travel/wanderlog/tests/fixtures/fake_sync_wlog.py`. This
script runs that reference on synthetic inputs and records its outputs, so `node --test` can
check that `src/sync.mjs` gives the same diff, drift, fingerprints and hashes.

  python3 test/fixtures/sync/gen_vectors.py <vault>/.claude/skills/travel

Inputs: desired-alpha.json (trip_derive.py output for the synthetic alpha-coast-trip fixture)
and lock-alpha.json (its lock). Everything here is invented; no real trip data.
"""
import copy
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TRAVEL = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(TRAVEL / 'wanderlog' / 'tests' / 'fixtures'))
import fake_sync_wlog as fake  # noqa: E402

desired = json.loads((HERE / 'desired-alpha.json').read_text())
lock = json.loads((HERE / 'lock-alpha.json').read_text())

OWNER = 4242


def place(bid, name, lat, lng, text, **extra):
    return {'id': bid, 'type': 'place', 'addedBy': {'type': 'user', 'userId': OWNER}, 'attachments': [],
            'imageKeys': ['img-1'], 'imageSize': 'small', 'upvotedBy': [], 'travelMode': None,
            'place': {'name': name, 'place_id': f'synthetic-{bid}', 'formatted_address': f'{name} street',
                      'geometry': {'location': {'lat': lat, 'lng': lng}}, 'types': ['museum'],
                      'photo_urls': ['https://example.org/p.jpg'], 'rating': 4.5},
            'text': {'ops': [{'insert': text}]}, **extra}


def section(sid, kind, mode, heading, blocks, date=None, text=None):
    out = {'id': sid, 'type': kind, 'mode': mode, 'heading': heading, 'blocks': blocks,
           'text': text or {'ops': [{'insert': '\n'}]}, 'placeMarkerColor': '#3f52e3', 'placeMarkerIcon': 'map-marker'}
    if kind != 'textOnly':
        out['date'] = date
    return out


ribeira = desired['sections'][-1]['blocks'][1]
assert ribeira['key'] == 'ribeira-walk'
app_ribeira = {'id': 555000001, 'type': 'place', 'addedBy': {'type': 'user', 'userId': OWNER}, 'attachments': [],
               'imageSize': 'small', 'upvotedBy': [], 'travelMode': None,
               'place': copy.deepcopy(ribeira['place']), 'text': copy.deepcopy(ribeira['text'])}

base = {'success': True, 'resources': {}, 'tripPlan': {
    'id': 77, 'key': 'alphatripkey0001', 'title': 'Alpha coast (synthetic)', 'userId': OWNER, 'overallVersion': 100,
    'startDate': '2027-05-11', 'endDate': '2027-05-12',
    'editKey': 'EDITSECRET01', 'viewKey': 'VIEWSECRET01', 'suggestKey': 'SUGGESTSECRET01', 'journalKey': 'JOURNALSECRET01',
    'TripPlanKeys': [{'key': 'TPKSECRET01', 'type': 'view'}, {'key': 'TPKSECRET02', 'type': 'edit'}],
    'itinerary': {'sections': [
        section(200000001, 'textOnly', 'placeList', 'Notes', [], text={'ops': [{'insert': 'Old notes\n'}]}),
        section(200000002, 'hotels', 'placeList', 'Hotels and lodging', [
            place(300000001, 'Harbour Inn', 38.7078, -9.1366, 'CONFIRMED · HB-10432\n',
                  hotel={'checkIn': '2027-05-10', 'checkOut': '2027-05-12', 'confirmationNumber': 'HB-10432',
                         'travelerNames': ['Traveller A']}),
        ]),
        section(200000099, 'normal', 'placeList', 'Places to visit', [
            place(300000099, 'Unmanaged cafe', 38.0, -9.0, 'not managed\n'),
        ]),
        section(200000003, 'normal', 'placeList', 'Trip admin', [
            {'id': 300000004, 'type': 'checklist', 'title': 'To do before the trip', 'attachments': [],
             'addedBy': {'type': 'user', 'userId': OWNER},
             'items': [{'id': 400000001, 'checked': False, 'text': {'ops': [{'insert': 'Buy travel insurance\n'}]}}]},
        ]),
        section(200000011, 'normal', 'dayPlan', '', [
            place(300000003, 'Tram 28 stop, Martim Moniz', 38.7158, -9.1357, 'PLANNED\n', startTime='09:00', endTime=None),
            place(300000002, 'National Tile Museum', 38.7249, -9.1136, 'TBD\n'),
        ], date='2027-05-11'),
        section(200000012, 'normal', 'dayPlan', 'Fly to Porto', [app_ribeira], date='2027-05-12'),
    ]}}}


def analyse(doc, d, lk):
    return fake.analyse(copy.deepcopy(doc), copy.deepcopy(d) if d is not None else None, copy.deepcopy(lk) if lk is not None else None)


def run_apply(doc, d, lk):
    doc = copy.deepcopy(doc)
    d2, _ = fake.match_new(doc, d, lk)
    fake.apply_desired(doc, d2, lk)
    return doc


vectors = {}
vectors['first_plan'] = {'doc': 'base', 'desired': True, 'lock': 'lock', 'expected': analyse(base, desired, lock)}

after = run_apply(base, desired, lock)
first = vectors['first_plan']['expected']
# The fake re-plans `insert_section` for a section it just inserted (its verify would exit 7), so
# the post-push view marks inserted sections as existing. src/sync.mjs does the same on verify.
landed = copy.deepcopy(desired)
for s in landed['sections']:
    s['new'] = False
post = analyse(after, landed, lock)
assert post['op_count'] == 0, post['ops']
vectors['verify_after_apply'] = {'doc': 'after', 'desired': True, 'lock': 'lock', 'expected': post}

# The lock trip_sync.py writes after a verified push: ids from desired (+matched), hashes from the CLI.
lock2 = {'lock_version': 1, 'sections': {}, 'entries': {}, 'section_hashes': post['hashes']['sections']}
for s in desired['sections']:
    sid = s['id']
    lock2['sections'][s['key']] = sid
    for b in s['blocks']:
        m = first['matched'].get(b['key'])
        entry = {'block': m['id'] if m else b['id'], 'hash': post['hashes']['entries'][b['key']]}
        rows = {r['key']: r['id'] for r in b.get('items', [])}
        if rows:
            entry['rows'] = rows
        lock2['entries'][b['key']] = entry
desired2 = copy.deepcopy(desired)
for s in desired2['sections']:
    s['new'] = False
    for b in s['blocks']:
        m = first['matched'].get(b['key'])
        if m:
            b['id'] = m['id']
        b['new'] = False
        for r in b.get('items', []):
            r['new'] = False

vectors['after_apply_plan'] = {'doc': 'after', 'desired': 'desired2', 'lock': 'lock2', 'expected': analyse(after, desired2, lock2)}
assert vectors['after_apply_plan']['expected']['op_count'] == 0
assert vectors['after_apply_plan']['expected']['drift'] == []

# App edits on the pushed state.
edited = copy.deepcopy(after)
secs = {s['id']: s for s in edited['tripPlan']['itinerary']['sections']}
day11 = secs[200000011]
day11['heading'] = 'Museums, fado and a nap'
tram = next(b for b in day11['blocks'] if b['id'] == 300000003)
tram['text'] = {'ops': [{'insert': 'May 10 · PLANNED\nEdited on the phone.\n'}]}
tram['startTime'] = '10:15'
day11['blocks'].append({'id': 666000001, 'type': 'note', 'addedBy': {'type': 'user', 'userId': OWNER}, 'attachments': [],
                        'text': {'ops': [{'insert': 'Added in the app\n'}]}})
day12 = secs[200000012]
day12['blocks'] = [b for b in day12['blocks'] if b['id'] != 555000001]
day12['blocks'].reverse()
admin = secs[200000003]
admin['blocks'][0]['items'][0]['checked'] = False
edited['tripPlan']['overallVersion'] += 3
vectors['drift_plan'] = {'doc': 'edited', 'desired': 'desired2', 'lock': 'lock2', 'expected': analyse(edited, desired2, lock2)}
vectors['drift_no_desired'] = {'doc': 'edited', 'desired': None, 'lock': 'lock2', 'expected': analyse(edited, None, lock2)}

# Refusals, each on the pushed state.
refusal_docs = {}


def variant(name, mutate):
    doc = copy.deepcopy(after)
    mutate(doc['tripPlan']['itinerary']['sections'])
    refusal_docs[name] = doc
    vectors[f'refuse_{name}'] = {'doc': f'refuse_{name}', 'desired': 'desired2', 'lock': 'lock2',
                                 'expected': analyse(doc, desired2, lock2)}
    assert vectors[f'refuse_{name}']['expected']['refusals'], name


def dup(ss):
    ss.append(copy.deepcopy(ss[2]))


def missing_section(ss):
    ss[:] = [s for s in ss if s['id'] != 200000003]


def moved_day(ss):
    next(s for s in ss if s['id'] == 200000012)['date'] = '2027-05-13'


def wiped(ss):
    for s in ss:
        if s['mode'] == 'dayPlan':
            s['blocks'] = []
    next(s for s in ss if s['id'] == 200000002)['blocks'] = []


def unknown_type(ss):
    next(s for s in ss if s['id'] == 200000011)['blocks'].append({'id': 777000001, 'type': 'flight', 'attachments': []})


def extra_day(ss):
    ss.append(section(200000013, 'normal', 'dayPlan', '', [], date='2027-05-13'))


for name, fn in [('duplicate', dup), ('missing_section', missing_section), ('moved_day', moved_day),
                 ('wiped', wiped), ('unknown_type', unknown_type), ('extra_day', extra_day)]:
    variant(name, fn)

out = {'_source': 'gen_vectors.py over the vault fake_sync_wlog.py (reference for the wlog sync contract)',
       'docs': {'base': base, 'after': after, 'edited': edited, **{f'refuse_{k}': v for k, v in refusal_docs.items()}},
       'desired2': desired2, 'lock2': lock2, 'vectors': vectors}
(HERE / 'vectors.json').write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + '\n')
print('wrote', len(vectors), 'vectors')
