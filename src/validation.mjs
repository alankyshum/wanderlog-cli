import { ValidationError } from './errors.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateTripPlanStructure(input = {}, opts = {}) {
  const tripPlan = unwrapTripPlan(input);
  const errors = [];
  const warnings = [];
  const sectionIds = new Set();
  const blockIds = new Set();

  if (!tripPlan || typeof tripPlan !== 'object') {
    errors.push('Missing tripPlan object');
    return result(errors, warnings, { sectionCount: 0, blockCount: 0 });
  }

  const sections = tripPlan.itinerary?.sections ?? tripPlan.sections;
  if (!Array.isArray(sections)) {
    errors.push('tripPlan.itinerary.sections must be an array');
    return result(errors, warnings, { sectionCount: 0, blockCount: 0 });
  }

  let blockCount = 0;
  sections.forEach((section, sectionIndex) => {
    const label = sectionLabel(section, sectionIndex);
    if (section?.id == null) {
      errors.push(`${label}: section is missing id`);
    } else if (sectionIds.has(String(section.id))) {
      errors.push(`${label}: duplicate section id ${section.id}`);
    } else {
      sectionIds.add(String(section.id));
    }

    if (!section || typeof section !== 'object') {
      errors.push(`${label}: section must be an object`);
      return;
    }
    if (typeof section.type !== 'string') errors.push(`${label}: section.type must be a string`);
    if (typeof section.mode !== 'string') errors.push(`${label}: section.mode must be a string`);
    if (section.text && !Array.isArray(section.text.ops)) warnings.push(`${label}: section.text.ops is missing or not an array`);

    const blocks = section.blocks;
    if (!Array.isArray(blocks)) {
      errors.push(`${label}: section.blocks must be an array`);
      return;
    }
    if (section.type === 'hotels') validateHotelsSection(section, sectionIndex, errors, warnings, opts);

    blockCount += blocks.length;
    blocks.forEach((block, blockIndex) => {
      validateBlock(block, { section, sectionIndex, blockIndex, blockIds, errors, warnings, opts });
    });
  });

  return result(errors, warnings, { sectionCount: sections.length, blockCount });
}

export function assertTripPlanValid(input, opts = {}) {
  const validation = validateTripPlanStructure(input, opts);
  if (!validation.valid) throw new ValidationError(formatValidationResult(validation));
  return validation;
}

export function formatValidationResult(validation = {}) {
  const errors = validation.errors || [];
  const warnings = validation.warnings || [];
  const summary = validation.summary || {};
  const lines = [
    validation.valid ? 'Trip structure valid' : 'Trip structure invalid',
    `sections: ${summary.sectionCount ?? 0}`,
    `blocks: ${summary.blockCount ?? 0}`,
  ];
  if (errors.length) lines.push('errors:', ...errors.map(error => `- ${error}`));
  if (warnings.length) lines.push('warnings:', ...warnings.map(warning => `- ${warning}`));
  return lines.join('\n');
}

function validateHotelsSection(section, sectionIndex, errors, warnings, opts) {
  const label = sectionLabel(section, sectionIndex);
  if (section.mode !== 'placeList') errors.push(`${label}: hotels section must use mode=placeList`);
  if (section.placeMarkerIcon && section.placeMarkerIcon !== 'bed') warnings.push(`${label}: hotels section should use placeMarkerIcon=bed`);
  if (opts.forbidHotelBookings) {
    errors.push(`${label}: scripted hotel booking sections are not supported; use wlog lodging add-place unless mirroring an existing native booking on the same trip`);
  }
}

function validateBlock(block, ctx) {
  const { section, sectionIndex, blockIndex, blockIds, errors, warnings } = ctx;
  const label = blockLabel(section, sectionIndex, blockIndex, block);
  if (!block || typeof block !== 'object') {
    errors.push(`${label}: block must be an object`);
    return;
  }
  if (block.id == null) {
    errors.push(`${label}: block is missing id`);
  } else if (blockIds.has(String(block.id))) {
    errors.push(`${label}: duplicate block id ${block.id}`);
  } else {
    blockIds.add(String(block.id));
  }
  if (typeof block.type !== 'string') errors.push(`${label}: block.type must be a string`);
  if (block.text && !Array.isArray(block.text.ops)) warnings.push(`${label}: block.text.ops is missing or not an array`);
  if (block.attachments != null && !Array.isArray(block.attachments)) errors.push(`${label}: attachments must be an array when present`);

  if (block.type === 'place') validatePlaceBlock(block, label, errors, warnings);
  if (block.hotel) validateHotelBlock(block, section, label, errors, warnings);
}

function validatePlaceBlock(block, label, errors, warnings) {
  const place = block.place;
  if (!place || typeof place !== 'object') {
    errors.push(`${label}: place block is missing place object`);
    return;
  }
  if (!place.name || typeof place.name !== 'string') errors.push(`${label}: place.name must be a non-empty string`);
  const location = place.geometry?.location;
  if (location) {
    if (!Number.isFinite(Number(location.lat))) errors.push(`${label}: place.geometry.location.lat must be numeric`);
    if (!Number.isFinite(Number(location.lng))) errors.push(`${label}: place.geometry.location.lng must be numeric`);
  } else {
    warnings.push(`${label}: place.geometry.location is missing`);
  }
}

function validateHotelBlock(block, section, label, errors, warnings) {
  if (section.type !== 'hotels') errors.push(`${label}: hotel metadata may only live in a section with type=hotels`);
  if (block.type !== 'place') errors.push(`${label}: hotel metadata block must have type=place`);
  const hotel = block.hotel;
  if (!hotel || typeof hotel !== 'object') {
    errors.push(`${label}: hotel metadata must be an object`);
    return;
  }
  if (!DATE_RE.test(String(hotel.checkIn || ''))) errors.push(`${label}: hotel.checkIn must match YYYY-MM-DD`);
  if (!DATE_RE.test(String(hotel.checkOut || ''))) errors.push(`${label}: hotel.checkOut must match YYYY-MM-DD`);
  if (DATE_RE.test(String(hotel.checkIn || '')) && DATE_RE.test(String(hotel.checkOut || '')) && hotel.checkIn > hotel.checkOut) {
    errors.push(`${label}: hotel.checkIn must be on or before hotel.checkOut`);
  }
  if (!Array.isArray(hotel.travelerNames)) warnings.push(`${label}: hotel.travelerNames should be an array`);
  if (!block.place?.place_id) warnings.push(`${label}: hotel place should include a Google place_id`);
}

function unwrapTripPlan(input) {
  return input.tripPlan
    ?? input.data?.tripPlan
    ?? input.raw?.tripPlan
    ?? input.raw?.data?.tripPlan
    ?? input;
}

function sectionLabel(section, sectionIndex) {
  return `section[${sectionIndex}]${section?.id != null ? `#${section.id}` : ''}`;
}

function blockLabel(section, sectionIndex, blockIndex, block) {
  return `${sectionLabel(section, sectionIndex)}.blocks[${blockIndex}]${block?.id != null ? `#${block.id}` : ''}`;
}

function result(errors, warnings, summary) {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary,
  };
}
