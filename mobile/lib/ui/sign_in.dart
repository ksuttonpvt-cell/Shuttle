import 'package:flutter/material.dart';

import '../api.dart';
import '../driver.dart';
import 'theme.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key, required this.driver});
  final Driver driver;
  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _show = false;
  String? _error;
  List<BusinessChoice> _choices = const [];

  @override
  void initState() {
    super.initState();
    widget.driver.store.lastEmail().then((e) {
      if (e != null && mounted && _email.text.isEmpty) setState(() => _email.text = e);
    });
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    if (_email.text.trim().isEmpty || _password.text.isEmpty) return setState(() => _error = 'Enter your email and password.');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await widget.driver.signIn(_email.text, _password.text);
      if (mounted && r.choices.isNotEmpty) setState(() => _choices = r.choices);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pick(BusinessChoice c) async {
    setState(() => _busy = true);
    try {
      await widget.driver.pickBusiness(c);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: AutofillGroup(
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  const BrandMark(size: 30, sub: 'Driver'),
                  const SizedBox(height: 36),
                  if (_choices.isEmpty) ...[
                    Text('Sign in', style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                    const SizedBox(height: 4),
                    Text('Use the email and password your manager gave you.', style: t.bodyMedium),
                    const SizedBox(height: 20),
                    TextField(
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.username, AutofillHints.email],
                      autocorrect: false,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(labelText: 'Email'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _password,
                      obscureText: !_show,
                      autofillHints: const [AutofillHints.password],
                      textInputAction: TextInputAction.go,
                      onSubmitted: (_) => _go(),
                      decoration: InputDecoration(
                        labelText: 'Password',
                        suffixIcon: IconButton(
                          tooltip: _show ? 'Hide password' : 'Show password',
                          icon: Icon(_show ? Icons.visibility_off : Icons.visibility),
                          onPressed: () => setState(() => _show = !_show),
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),
                    FilledButton(onPressed: _busy ? null : _go, child: Text(_busy ? 'Signing in…' : 'Sign in')),
                  ] else ...[
                    Text('Which business?', style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                    const SizedBox(height: 4),
                    const Text('You drive for more than one.'),
                    const SizedBox(height: 16),
                    for (final c in _choices)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: OutlinedButton(onPressed: _busy ? null : () => _pick(c), child: Text(c.name)),
                      ),
                    TextButton(onPressed: () => setState(() => _choices = const []), child: const Text('Back')),
                  ],
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 14),
                      child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontWeight: FontWeight.w600)),
                    ),
                  const SizedBox(height: 28),
                  Text('Forgot your password? Ask a manager at your business for a reset link.', style: t.bodySmall, textAlign: TextAlign.center),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
