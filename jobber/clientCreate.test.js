/**
 * Client create input must match Jobber's ClientCreateInput.
 * Run: node jobber/clientCreate.test.js
 */
import { buildClientCreateInput, propertyAttributes } from './client.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

{
  const input = buildClientCreateInput({
    firstName: 'Cornie',
    lastName: 'Van Den Broek',
    companyName: 'Van Den Broek Concrete, Inc.',
    isCompany: false,
    isLead: true,
    note: 'Madison 641-638-0620',
    phone: '641-660-0109',
    billingAddress: {
      street1: '1444 Fisher Avenue',
      city: 'New Sharon',
      province: 'IA',
      postalCode: '50207',
    },
    properties: [
      {
        name: '704 G Avenue West',
        street1: '704 G Avenue West',
        city: 'Oskaloosa',
        province: 'IA',
        postalCode: '52577',
      },
    ],
  });
  assert(!('isLead' in input), 'isLead is not a ClientCreateInput field');
  assert(!('note' in input), 'note is not a ClientCreateInput field');
  assert(input.billingAddress.city === 'New Sharon', 'mailing address stays billing');
  assert(input.properties.length === 1, 'one service property');
  assert(input.properties[0].address.street1 === '704 G Avenue West', 'job site street');
  assert(input.properties[0].address.city === 'Oskaloosa', 'job site city');
  assert(input.properties[0].name === '704 G Avenue West', 'property name');
  assert(!('name' in input.properties[0].address), 'name is not an address field');
  assert(input.phones[0].number === '641-660-0109', 'phone');
  assert(input.isCompany === false, 'person with a company name');
}

{
  const row = propertyAttributes({
    address: { street1: '704 G Avenue West', city: 'Oskaloosa' },
    name: 'House',
  });
  assert(row.address.street1 === '704 G Avenue West' && row.name === 'House', 'nested address');
}

console.log('clientCreate.test.js: all assertions passed');
