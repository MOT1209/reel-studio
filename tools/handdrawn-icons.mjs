// Reel Studio hand-drawn icon set (original work, released with the project under CC0).
// 24×24 grid, stroke-only, round caps. Each icon: { tags, paths:[d] }.
export const HANDDRAWN = {
  atom: {
    tags: ['atom', 'nucleus', 'electron', 'physics', 'proton'],
    paths: [
      'M2 12a10 4 0 1 0 20 0a10 4 0 1 0 -20 0',
      'M7 3.34A10 4 60 1 0 17 20.66A10 4 60 1 0 7 3.34',
      'M7 20.66A10 4 -60 1 0 17 3.34A10 4 -60 1 0 7 20.66',
      'M10.6 12a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0 -2.8 0',
    ],
  },
  cell: {
    tags: ['cell', 'cells', 'biology', 'organism', 'tissue'],
    paths: [
      'M12 2.8c4.6 0 8.6 3.4 8.9 8.1c.3 5.2-3.6 10-8.9 10.2c-5.1.2-9.3-3.6-9.2-9.1C2.9 6.5 7 2.8 12 2.8z',
      'M10 11a3.5 3.2 0 1 0 7 0a3.5 3.2 0 1 0 -7 0',
      'M12.6 10.6a.9.9 0 1 0 1.8 0a.9.9 0 1 0 -1.8 0',
      'M6 14.5c.8-.8 2-.8 2.8 0',
      'M7.5 7.5h.01',
      'M15.5 17.2h.01',
      'M6.8 17.6c.6.4 1.4.4 2 0',
    ],
  },
  neuron: {
    tags: ['neuron', 'nerve', 'brain cell', 'synapse', 'signal'],
    paths: [
      'M5.5 8.5a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0 -5.6 0',
      'M6.2 6.4 3.5 3.8', 'M3.5 3.8 2.5 5.5', 'M3.5 3.8 5 2.6',
      'M10.4 6.3 12 3', 'M5.6 10.4 3 12',
      'M10.6 10.3c2.6 2 4.4 4.2 6.4 7.2',
      'M17 17.5l3.5.5', 'M17 17.5l1.2 3.4', 'M17 17.5l3 -2',
      'M12.2 11.6l1.2-.9', 'M14 13.6l1.2-.9', 'M15.6 15.6l1.2-.9',
    ],
  },
  molecule: {
    tags: ['molecule', 'chemistry', 'compound', 'bond', 'chemical'],
    paths: [
      'M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0',
      'M3 5.5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
      'M17 5.5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
      'M10 19.5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
      'M6.5 7l3.6 3.3', 'M17.5 7l-3.6 3.3', 'M12 14.5v3',
    ],
  },
  wave: {
    tags: ['wave', 'frequency', 'vibration', 'signal', 'sound wave', 'light wave'],
    paths: ['M2 12c1.7-5 3.3-5 5 0s3.3 5 5 0s3.3-5 5 0s3.3 5 5 0'],
  },
  sun: {
    tags: ['sun', 'sunlight', 'star', 'light', 'heat', 'day'],
    paths: [
      'M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
      'M12 2.5v2', 'M12 19.5v2', 'M2.5 12h2', 'M19.5 12h2',
      'M5.3 5.3l1.4 1.4', 'M17.3 17.3l1.4 1.4', 'M5.3 18.7l1.4-1.4', 'M17.3 6.7l1.4-1.4',
    ],
  },
  drop: {
    tags: ['drop', 'water', 'liquid', 'droplet', 'rain', 'sweat'],
    paths: ['M12 3c-3 4.5-6 8-6 11a6 6 0 0 0 12 0c0-3-3-6.5-6-11z', 'M9 14.5a3 3 0 0 0 2.5 3'],
  },
  dna: {
    tags: ['dna', 'gene', 'genetics', 'helix', 'chromosome', 'genome'],
    paths: [
      'M7 2c0 5 10 5 10 10s-10 5-10 10',
      'M17 2c0 5-10 5-10 10s10 5 10 10',
      'M8.5 5h7', 'M9 8.5h6', 'M9 15.5h6', 'M8.5 19h7',
    ],
  },
  virus: {
    tags: ['virus', 'germ', 'infection', 'pathogen', 'flu'],
    paths: [
      'M7 12a5 5 0 1 0 10 0a5 5 0 1 0 -10 0',
      'M12 7V4', 'M12 20v-3', 'M7 12H4', 'M20 12h-3',
      'M8.5 8.5 6.4 6.4', 'M15.5 15.5l2.1 2.1', 'M8.5 15.5l-2.1 2.1', 'M15.5 8.5l2.1-2.1',
      'M11 3h2', 'M11 21h2', 'M3 11v2', 'M21 11v2',
      'M10.5 11h.01', 'M13.5 13.5h.01',
    ],
  },
  magnet: {
    tags: ['magnet', 'magnetism', 'magnetic', 'attraction', 'force'],
    paths: ['M5 3h4v8a3 3 0 0 0 6 0V3h4v8a7 7 0 0 1-14 0z', 'M5 7h4', 'M15 7h4'],
  },
  planet: {
    tags: ['planet', 'saturn', 'space', 'orbit', 'universe', 'astronomy'],
    paths: [
      'M6.5 12a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0',
      'M7.2 9.3C3.6 9 1.6 9.8 2 11.2c.5 1.9 5.5 3.3 11 3.1s9.6-1.9 9-3.8c-.4-1.3-2.5-1.9-5.4-1.9',
    ],
  },
  bulb: {
    tags: ['bulb', 'idea', 'lamp', 'light bulb', 'electricity', 'think'],
    paths: [
      'M9 17h6', 'M10 20.5h4',
      'M9 17c0-2.2-3-3.6-3-7.2a6 6 0 0 1 12 0c0 3.6-3 5-3 7.2',
      'M12 6.5a3.2 3.2 0 0 0-3.2 3.2',
    ],
  },
  heart: {
    tags: ['heart', 'love', 'pulse', 'cardio', 'heartbeat'],
    paths: ['M12 20s-7.5-4.6-7.5-10.2a4.1 4.1 0 0 1 7.5-2.4a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z', 'M7.5 11.5h2.3l1.2-2.2 1.8 4.2 1.2-2h2.5'],
  },
  question: {
    tags: ['question', 'why', 'ask', 'mystery', 'unknown', 'help'],
    paths: [
      'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0',
      'M9.4 9.5a2.7 2.7 0 1 1 3.8 2.5c-.8.4-1.2 1-1.2 1.8v.7',
      'M12 17.2h.01',
    ],
  },
  bolt: {
    tags: ['bolt', 'lightning', 'electricity', 'energy', 'power', 'charge', 'spark'],
    paths: ['M13 2.5 5 14h6l-1 7.5L18.5 10h-6.2z'],
  },
  flame: {
    tags: ['flame', 'fire', 'burn', 'heat', 'combustion', 'hot'],
    paths: ['M12 21.5c-3.8 0-6.5-2.6-6.5-6.2c0-4.3 4.2-6.5 4.5-11.8c3 1.7 4.6 4.6 4.6 7c1-.7 1.7-1.9 1.8-3.2c1.6 1.6 2.1 4.2 2.1 6c0 4.4-2.8 8.2-6.5 8.2z', 'M12 21.5c-1.6 0-2.8-1.2-2.8-2.9c0-1.9 1.7-2.9 2.6-5c1.6 1.2 3 3 3 4.8c0 1.8-1.2 3.1-2.8 3.1z'],
  },
  leaf: {
    tags: ['leaf', 'plant', 'nature', 'photosynthesis', 'green', 'tree'],
    paths: ['M4.5 19.5C4 11 9 4.5 20 4c.5 10.5-5.5 15.8-14 15.5z', 'M4.5 19.5 14 10'],
  },
  thermometer: {
    tags: ['thermometer', 'temperature', 'fever', 'degree', 'heat', 'cold'],
    paths: ['M10 13.5V5a2 2 0 0 1 4 0v8.5a4 4 0 1 1-4 0z', 'M12 9v6.5', 'M16.5 6h2', 'M16.5 9h2'],
  },
  eye: {
    tags: ['eye', 'vision', 'see', 'sight', 'look'],
    paths: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0'],
  },
  clock: {
    tags: ['clock', 'time', 'hour', 'timer', 'duration', 'age'],
    paths: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 7v5l3.2 2'],
  },
  cloud: {
    tags: ['cloud', 'weather', 'sky', 'vapor', 'steam'],
    paths: ['M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.9a4.3 4.3 0 0 1-.5 8.6z'],
  },
  arrow: {
    tags: ['arrow', 'next', 'direction', 'forward', 'move'],
    paths: ['M20 12H4', 'M10 6l-6 6 6 6'],
  },
  check: {
    tags: ['check', 'done', 'correct', 'yes', 'true', 'ok'],
    paths: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M8 12.3l2.7 2.7L16.2 9.5'],
  },
  person: {
    tags: ['person', 'human', 'man', 'woman', 'people', 'user'],
    paths: ['M9 5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M6 21v-6.5a6 6 0 0 1 12 0V21', 'M9.5 21v-5', 'M14.5 21v-5'],
  },
  microscope: {
    tags: ['microscope', 'lab', 'research', 'science', 'micro'],
    paths: ['M5 21h14', 'M7 18h7', 'M10.5 18a5.5 5.5 0 0 0 7-7.7', 'M9 4l3 -1.2 3.4 7.8-3 1.2z', 'M11.6 11.8l1.2 2.7'],
  },
  bacteria: {
    tags: ['bacteria', 'bacterium', 'microbe', 'germ', 'microorganism'],
    paths: ['M7.5 7.5c1.6-1.6 4-1.2 6.4 1.2l2 2c2.4 2.4 2.8 4.8 1.2 6.4s-4 1.2-6.4-1.2l-2-2C6.3 11.5 5.9 9.1 7.5 7.5z', 'M17.2 17.2l2.6 2.6', 'M7.5 7.5 4.8 4.2', 'M5.6 12.4 3 13', 'M12.4 5.6 13 3', 'M10.5 10.5h.01', 'M13.6 13.6h.01'],
  },
  blood_cell: {
    tags: ['red blood cell', 'blood cell', 'erythrocyte', 'hemoglobin'],
    paths: ['M3 12a9 7 0 1 0 18 0a9 7 0 1 0 -18 0', 'M8 12a4 2.4 0 1 0 8 0a4 2.4 0 1 0 -8 0'],
  },
  mountain: {
    tags: ['mountain', 'earth', 'rock', 'land', 'geology'],
    paths: ['M2.5 20 9.5 7l4 7 2-3 6 9z', 'M7.7 10.4l1.8 1.4 1.6-1.1'],
  },
  rocket: {
    tags: ['rocket', 'launch', 'space', 'spaceship', 'fast'],
    paths: ['M12 2.5c3 2.2 4.5 5.7 4.5 9.5L14 16h-4l-2.5-4c0-3.8 1.5-7.3 4.5-9.5z', 'M10.5 9a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0', 'M7.5 12 5 14.5V18l3.5-2', 'M16.5 12l2.5 2.5V18l-3.5-2', 'M11 19.5l1 2 1-2'],
  },
  battery: {
    tags: ['battery', 'energy', 'charge', 'power', 'storage'],
    paths: ['M3 8.5a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 19 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 15.5z', 'M21 10.5v3', 'M6 10v4', 'M9 10v4', 'M12 10v4'],
  },
  dot: {
    tags: ['dot', 'point', 'generic', 'thing', 'item'],
    paths: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0'],
  },
};
