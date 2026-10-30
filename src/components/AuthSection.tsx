import React, { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../firebase';
import {
  downloadUnsyncedLocalBackupJson,
  LegacyLocalDataSummary,
} from '../utils/legacyLocalBackup';

interface AuthSectionProps {
  legacyLocalData?: LegacyLocalDataSummary | null;
}

export const AuthSection: React.FC<AuthSectionProps> = ({ legacyLocalData }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      setPassword('');
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: string }).code)
          : 'auth/error';
      if (code.includes('network-request-failed')) {
        setError(
          'Unable to connect to Firebase Authentication (network-request-failed). Check your internet connection and try again.'
        );
      } else {
        setError(`Sign-in failed (${code}). Check your email and password.`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-center items-center px-4 py-12 bg-canvas">
      <div className="w-full max-w-md bg-surface border border-line rounded-xl p-8 shadow-xs">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 rounded-xs bg-brand shrink-0" aria-hidden="true" />
            <span className="text-xs font-bold tracking-wider uppercase text-brand-text">
              WOOPP ART &amp; CRAFT
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            Print Production System 5.0
          </h1>
          <p className="text-sm text-ink-secondary mt-1.5">
            Sign in with your <span className="font-mono-data font-medium text-ink">woopp-tracker</span> Firebase Email/Password account to access Cloud Firestore production records.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="loginEmail"
              className="block text-xs font-semibold text-ink-secondary mb-1.5"
            >
              Email Address
            </label>
            <input
              id="loginEmail"
              type="email"
              autoComplete="username"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-line bg-input text-sm text-ink placeholder:text-muted focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/25 transition-colors"
            />
          </div>

          <div>
            <label
              htmlFor="loginPassword"
              className="block text-xs font-semibold text-ink-secondary mb-1.5"
            >
              Password
            </label>
            <input
              id="loginPassword"
              type="password"
              autoComplete="current-password"
              required
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-line bg-input text-sm text-ink placeholder:text-muted focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/25 transition-colors"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-error-soft border border-error-border text-xs font-medium text-error-text"
            >
              {error}
            </div>
          )}

          <div className="pt-1">
            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-2.5 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-50 text-white text-sm font-semibold transition-colors whitespace-nowrap"
            >
              {loading ? 'Signing in...' : 'Sign in to Cloud'}
            </button>
          </div>
        </form>

        {legacyLocalData && (
          <div className="mt-5 p-3.5 rounded-lg bg-warning-soft border border-warning-border space-y-2.5">
            <div className="text-xs text-warning-text leading-relaxed">
              <span className="font-semibold">Previous local browser data detected:</span>{' '}
              {legacyLocalData.projectCount} project(s) and {legacyLocalData.jobCount} plate(s) stored in this browser. Sign in above to migrate into Cloud Firestore, or export a JSON backup copy now.
            </div>
            <button
              type="button"
              onClick={() => downloadUnsyncedLocalBackupJson(legacyLocalData)}
              className="w-full px-3 py-1.5 rounded-lg border border-warning-border bg-surface hover:bg-elevated text-xs font-semibold text-warning-text transition-colors"
            >
              Download Unsynced Local Backup (.json)
            </button>
          </div>
        )}

        <div className="mt-6 pt-5 border-t border-line text-xs font-mono-data text-muted flex items-center justify-between">
          <span>Cloud Firestore · woopp-tracker</span>
          <span>Firebase Auth Required</span>
        </div>
      </div>
    </div>
  );
};
