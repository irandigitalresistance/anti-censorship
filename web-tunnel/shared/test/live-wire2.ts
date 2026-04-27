import { BaleClient, GrpcError } from '../src/index.js';

async function main(): Promise<void> {
  const client = new BaleClient();
  try {
    const r = await client.startPhoneAuth('100000000000');
    console.log('unexpected success:', r);
  } catch (e) {
    if (e instanceof GrpcError) {
      console.log('GrpcError. http=', e.httpStatus, 'grpc=', e.status);
      console.log('message:', e.message);
    } else {
      console.log('Non-grpc error:', e);
    }
  }
}
main();
