import React, { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../firebase';

interface AuthSectionProps {
  onOfflineDemo: () => void;
}

export const AuthSection: React.FC<AuthSectionProps> = ({ onOfflineDemo }) => {
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
      setError(`Sign-in failed (${code}). Check your email and password.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-center items-center px-4 py-12 bg-[#faf9fd] dark:bg-[#111018]">
      <div className="w-full max-w-md bg-white dark:bg-[#171522] border border-neutral-200 dark:border-neutral-800 rounded-2xl p-8">
        <div className="mb-6">
          <div className="text-xs font-semibold text-[#6c4ce6] dark:text-[#b49eff] mb-1">
            WOOPP ART &amp; CRAFT
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-white">
            Print Production System 5.0
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1.5">
            Sign in with your existing <span className="font-medium">woopp-tracker</span> Firebase Email/Password account. Existing v1 records migrate automatically without overwriting legacy data.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="loginEmail"
              className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1.5"
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
              className="w-full px-3.5 py-2.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6c4ce6]"
            />
          </div>

          <div>
            <label
              htmlFor="loginPassword"
              className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1.5"
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
              className="w-full px-3.5 py-2.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6c4ce6]"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs font-medium text-red-700 dark:text-red-300"
            >
              {error}
            </div>
          )}

          <div className="pt-1 flex flex-col sm:flex-row gap-2.5">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2.5 rounded-xl bg-[#6c4ce6] hover:bg-[#5b3cc4] disabled:opacity-50 text-white text-sm font-semibold transition-colors whitespace-nowrap"
            >
              {loading ? 'Signing in...' : 'Sign in to Cloud'}
            </button>
            <button
              type="button"
              onClick={onOfflineDemo}
              className="px-4 py-2.5 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/60 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-200 text-sm font-medium transition-colors whitespace-nowrap"
            >
              Local Workspace
            </button>
          </div>
        </form>

        <div className="mt-6 pt-5 border-t border-neutral-100 dark:border-neutral-800 text-xs text-neutral-400 dark:text-neutral-500 flex items-center justify-between">
          <span>Cloud Firestore · woopp-tracker</span>
          <span>Account Isolated</span>
        </div>
      </div>
    </div>
  );
};
