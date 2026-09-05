// Residents' identities. Everything is derived from a seed, so the same resident is always the same
// person. Name data from nymshift's England/Wales name set; occupations and the rest from its taxonomy.
import { seededRandom } from './city.js';

export const NAMES = {
  male: ['Oliver', 'George', 'Arthur', 'Noah', 'Muhammad', 'Leo', 'Oscar', 'Harry', 'Archie', 'Jack', 'Henry', 'Charlie', 'Freddie', 'Theodore', 'Thomas', 'Finley', 'Alfie', 'Jacob', 'William', 'Isaac', 'Joshua', 'Alexander', 'James', 'Lucas', 'Edward'],
  female: ['Olivia', 'Amelia', 'Isla', 'Ava', 'Ivy', 'Freya', 'Lily', 'Florence', 'Mia', 'Willow', 'Rosie', 'Sophia', 'Isabella', 'Grace', 'Daisy', 'Sienna', 'Poppy', 'Elsie', 'Emily', 'Ella', 'Evelyn', 'Phoebe', 'Sophie', 'Evie', 'Charlotte'],
  surnames: ['Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson', 'Davies', 'Patel', 'Robinson', 'Wright', 'Thompson', 'Evans', 'Walker', 'White', 'Roberts', 'Green', 'Hall', 'Wood', 'Jackson', 'Clarke', 'Turner', 'Phillips', 'Hill', 'Moore'],
};

export const OCCUPATIONS = ['Account manager', 'Architect', 'Barista', 'Biomedical engineer', 'Bookkeeper', 'Chef', 'Civil engineer', 'Customer support analyst', 'Data analyst', 'Dental hygienist', 'Electrician', 'Event planner', 'Financial controller', 'Graphic designer', 'HR coordinator', 'Industrial designer', 'IT support specialist', 'Journalist', 'Legal assistant', 'Logistics planner', 'Marketing strategist', 'Mechanical technician', 'Nurse practitioner', 'Operations manager', 'Paramedic', 'Pharmacist', 'Product manager', 'Project coordinator', 'QA tester', 'Real estate agent', 'Research assistant', 'Sales consultant', 'School teacher', 'Software developer', 'Supply chain analyst', 'Technical writer', 'UX researcher', 'Veterinary nurse', 'Warehouse supervisor', 'Web developer'];
export const EMPLOYERS = ['Aster Labs', 'Blueforge Systems', 'Cedar & Finch', 'Copperline Logistics', 'DatumWorks', 'Echelon Foods', 'Fieldstone Medical', 'Granite Retail Group', 'Harborlight Studio', 'Ironbridge Finance', 'Juniper Analytics', 'Kestrel Energy', 'Lumen Care', 'Meridian Trading', 'Northstar Digital', 'Oakwell Design', 'Praxis Mobility', 'Quartz Security', 'Redwood Clinics', 'Silverline Media', 'Tandem Robotics', 'Umbra Textiles', 'Vector Harbor', 'Westfield Services', 'Zenith Components'];
export const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
export const EYE_COLOURS = ['Amber', 'Blue', 'Brown', 'Grey', 'Green', 'Hazel'];
export const HAIR_COLOURS = ['Black', 'Blond', 'Brown', 'Dark brown', 'Grey', 'Red'];

// Swatches for drawing the portrait.
export const EYE_SWATCH = { Amber: '#ffb000', Blue: '#4aa3ff', Brown: '#7a4a22', Grey: '#9aa3ad', Green: '#3fbf5f', Hazel: '#9a7a3a' };
export const HAIR_SWATCH = { Black: '#151515', Blond: '#f2d16b', Brown: '#6b4423', 'Dark brown': '#3b2615', Grey: '#b9b9b9', Red: '#c4442a' };

// Stable 32-bit seed for a resident: the repository name and the resident's index.
export function residentSeed(repo, index) {
  let hash = 2166136261;
  for (const char of `${repo}#${index}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function personFor(seed) {
  const random = seededRandom(seed), pick = list => list[Math.floor(random() * list.length)];
  const sex = random() < .5 ? 'Male' : 'Female';
  return {
    id: `CN-${seed.toString(16).toUpperCase().padStart(8, '0')}`,
    sex,
    firstName: pick(sex === 'Male' ? NAMES.male : NAMES.female),
    surname: pick(NAMES.surnames),
    age: 18 + Math.floor(random() * 63),
    occupation: pick(OCCUPATIONS),
    employer: pick(EMPLOYERS),
    eyeColour: pick(EYE_COLOURS),
    hairColour: pick(HAIR_COLOURS),
    bloodType: pick(BLOOD_TYPES),
    get name() { return `${this.firstName} ${this.surname}`; },
  };
}

// Head-and-shoulders portrait in the residents' glowing stick-figure style.
export function drawPortrait(ctx, person, width, height) {
  const green = '#52ff61', cx = width / 2, headY = height * .42, head = width * .2;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0d1a0f'; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(82,255,97,.08)'; ctx.lineWidth = 1;
  for (let y = 4; y < height; y += 6) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); } // scanlines
  ctx.save();
  ctx.shadowColor = green; ctx.shadowBlur = 14; ctx.strokeStyle = green; ctx.lineCap = 'round';
  // Shoulders and neck.
  ctx.lineWidth = width * .075;
  ctx.beginPath(); ctx.moveTo(cx - width * .36, height * 1.02); ctx.quadraticCurveTo(cx - width * .3, height * .78, cx, height * .76); ctx.quadraticCurveTo(cx + width * .3, height * .78, cx + width * .36, height * 1.02); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, headY + head); ctx.lineTo(cx, height * .76); ctx.stroke();
  // Head.
  ctx.fillStyle = green; ctx.beginPath(); ctx.arc(cx, headY, head, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // Hair: a cap over the top of the head.
  ctx.fillStyle = HAIR_SWATCH[person.hairColour] || '#333';
  ctx.beginPath(); ctx.arc(cx, headY, head * 1.04, Math.PI * 1.05, Math.PI * 1.95); ctx.closePath(); ctx.fill();
  if (person.sex === 'Female') { ctx.fillRect(cx - head * 1.04, headY - head * .2, head * .3, head * 1.2); ctx.fillRect(cx + head * .74, headY - head * .2, head * .3, head * 1.2); }
  // Eyes and a small, slightly unimpressed mouth.
  ctx.fillStyle = EYE_SWATCH[person.eyeColour] || '#000';
  for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(cx + side * head * .36, headY + head * .08, head * .13, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = '#0d1a0f'; ctx.lineWidth = head * .1; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(cx - head * .25, headY + head * .5); ctx.lineTo(cx + head * .25, headY + head * .46); ctx.stroke();
}
