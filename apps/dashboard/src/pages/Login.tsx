import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input } from '../ui.tsx';

export function Login() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const res = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError(res?.status === 401 ? 'Wrong email or password.' : 'Could not sign in. Try again.');
      return;
    }
    await qc.invalidateQueries({ queryKey: ['me'] });
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <form
        onSubmit={(e) => void submit(e)}
        className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div>
          <h1 className="text-lg font-semibold text-brand-700">InstantLead</h1>
          <p className="text-sm text-slate-500">Sign in to your clinic dashboard</p>
        </div>
        <Field label="Email">
          <Input name="email" type="email" autoComplete="username" required />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" autoComplete="current-password" required />
        </Field>
        {error && (
          <p className="text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" loading={busy} className="w-full">
          Sign in
        </Button>
      </form>
    </div>
  );
}
