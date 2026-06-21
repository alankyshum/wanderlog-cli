import test from 'node:test';
import assert from 'node:assert/strict';

import { validateTripPlanStructure } from '../src/validation.mjs';

test('validateTripPlanStructure accepts normal day-plan lodging place blocks', () => {
  const validation = validateTripPlanStructure({
    tripPlan: {
      itinerary: {
        sections: [{
          id: 440038987,
          heading: 'AYANA Arrival + Accommodation',
          type: 'normal',
          mode: 'dayPlan',
          text: { ops: [{ insert: '\n' }] },
          blocks: [{
            id: 911771177,
            type: 'place',
            place: {
              name: 'AYANA Villas Bali',
              place_id: 'ChIJe2lg4gJF0i0Rl_8LzZd5b4I',
              geometry: { location: { lat: -8.788001, lng: 115.1366264 } },
              formatted_address: 'AYANA Bali, Jimbaran, Bali, Indonesia',
              types: ['hotel', 'lodging'],
            },
            text: { ops: [{ insert: 'Lodging notes\n' }] },
            attachments: [],
          }],
        }],
      },
    },
  }, { forbidHotelBookings: true });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.summary.sectionCount, 1);
  assert.equal(validation.summary.blockCount, 1);
});

test('validateTripPlanStructure can forbid scripted hotel booking sections', () => {
  const validation = validateTripPlanStructure({
    tripPlan: {
      itinerary: {
        sections: [{
          id: 554094205,
          heading: 'Hotels and lodging',
          type: 'hotels',
          mode: 'placeList',
          placeMarkerIcon: 'hotel',
          text: { ops: [{ insert: '\n' }] },
          blocks: [{
            id: 911771177,
            type: 'place',
            place: {
              name: 'AYANA Villas Bali',
              place_id: 'ChIJe2lg4gJF0i0Rl_8LzZd5b4I',
              geometry: { location: { lat: -8.788001, lng: 115.1366264 } },
            },
            hotel: { checkIn: '2027-09-22', checkOut: '2027-09-24', confirmationNumber: '', travelerNames: [] },
            text: { ops: [{ insert: 'Booking notes\n' }] },
            attachments: [],
          }],
        }],
      },
    },
  }, { forbidHotelBookings: true });

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /scripted hotel booking sections are not supported/);
});

test('validateTripPlanStructure catches hotel metadata outside hotels section', () => {
  const validation = validateTripPlanStructure({
    tripPlan: {
      itinerary: {
        sections: [{
          id: 440038987,
          heading: 'Arrival',
          type: 'normal',
          mode: 'dayPlan',
          blocks: [{
            id: 1,
            type: 'place',
            place: { name: 'Hotel', geometry: { location: { lat: 1, lng: 2 } } },
            hotel: { checkIn: '2027-09-22', checkOut: '2027-09-24', travelerNames: [] },
          }],
        }],
      },
    },
  });

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /hotel metadata may only live in a section with type=hotels/);
});
