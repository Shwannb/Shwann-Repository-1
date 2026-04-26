import Terminal from './terminal';
import { isAuthEnabled } from '@/lib/auth';

export default function HomePage() {
  return <Terminal authEnabled={isAuthEnabled()} />;
}
