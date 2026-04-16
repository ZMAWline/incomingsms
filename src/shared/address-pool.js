const ADDRESS_POOL = [
  { address1: '1701 4th Ave N',           city: 'Birmingham',   state: 'AL', zipCode: '35203' },
  { address1: '200 W Washington St',       city: 'Phoenix',      state: 'AZ', zipCode: '85003' },
  { address1: '200 N Spring St',           city: 'Los Angeles',  state: 'CA', zipCode: '90012' },
  { address1: '1701 Wynkoop St',           city: 'Denver',       state: 'CO', zipCode: '80202' },
  { address1: '601 Biscayne Blvd',         city: 'Miami',        state: 'FL', zipCode: '33132' },
  { address1: '265 Peachtree St NE',       city: 'Atlanta',      state: 'GA', zipCode: '30303' },
  { address1: '233 S Wacker Dr',           city: 'Chicago',      state: 'IL', zipCode: '60606' },
  { address1: '100 S Capitol Ave',         city: 'Indianapolis', state: 'IN', zipCode: '46225' },
  { address1: '401 W Main St',             city: 'Louisville',   state: 'KY', zipCode: '40202' },
  { address1: '701 Chartres St',           city: 'New Orleans',  state: 'LA', zipCode: '70116' },
  { address1: '400 Atlantic Ave',          city: 'Boston',       state: 'MA', zipCode: '02110' },
  { address1: '400 Renaissance Center',    city: 'Detroit',      state: 'MI', zipCode: '48243' },
  { address1: '730 2nd Ave S',             city: 'Minneapolis',  state: 'MN', zipCode: '55402' },
  { address1: '1 S Memorial Dr',           city: 'St. Louis',    state: 'MO', zipCode: '63102' },
  { address1: '3600 Las Vegas Blvd S',     city: 'Las Vegas',    state: 'NV', zipCode: '89109' },
  { address1: '1 Center St',               city: 'Newark',       state: 'NJ', zipCode: '07102' },
  { address1: '350 5th Ave',               city: 'New York',     state: 'NY', zipCode: '10118' },
  { address1: '100 N Tryon St',            city: 'Charlotte',    state: 'NC', zipCode: '28202' },
  { address1: '150 E Gay St',              city: 'Columbus',     state: 'OH', zipCode: '43215' },
  { address1: '1120 SW 5th Ave',           city: 'Portland',     state: 'OR', zipCode: '97204' },
  { address1: '1 N Broad St',              city: 'Philadelphia', state: 'PA', zipCode: '19107' },
  { address1: '50 Peabody St',             city: 'Nashville',    state: 'TN', zipCode: '37210' },
  { address1: '1100 Congress Ave',         city: 'Austin',       state: 'TX', zipCode: '78701' },
  { address1: '400 Broad St',              city: 'Seattle',      state: 'WA', zipCode: '98109' },
  { address1: '750 N Lincoln Memorial Dr', city: 'Milwaukee',    state: 'WI', zipCode: '53202' },
];

export function pickRandomAddress() {
  return ADDRESS_POOL[Math.floor(Math.random() * ADDRESS_POOL.length)];
}
