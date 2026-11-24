import 'package:flutter/material.dart';

const purple = Color(0xFF6D28D9);
const teal = Color(0xFF0D9488);
const neon = Color(0xFF39FF88);
const night = Color(0xFF0B1020);

ThemeData turasTheme(Brightness b) {
  final dark = b == Brightness.dark;
  final scheme = ColorScheme.fromSeed(seedColor: purple, brightness: b, primary: dark ? const Color(0xFFA78BFA) : purple, secondary: teal);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: dark ? night : const Color(0xFFF6F7F9),
    cardTheme: CardThemeData(
      elevation: 0,
      color: dark ? const Color(0xFF141B2D) : Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: dark ? const Color(0xFF243044) : const Color(0xFFE4E7EB))),
      margin: EdgeInsets.zero,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56), textStyle: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(minimumSize: const Size(0, 48), textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: dark ? const Color(0xFF141B2D) : Colors.white,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
    ),
  );
}

/// "Turas Lúbtha" with the van-in-a-terminal feel: Turas in ink, Lúbtha in the pop color.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 24, this.sub});
  final double size;
  final String? sub;
  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Column(mainAxisSize: MainAxisSize.min, children: [
      FittedBox(fit: BoxFit.scaleDown, child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.airport_shuttle_rounded, size: size * 1.2, color: purple),
        SizedBox(width: size * .35),
        Text.rich(TextSpan(children: [
          TextSpan(text: 'Turas ', style: TextStyle(fontWeight: FontWeight.w800, color: dark ? Colors.white : const Color(0xFF111827))),
          TextSpan(text: 'Lúbtha', style: TextStyle(fontWeight: FontWeight.w800, color: dark ? neon : purple)),
        ]), style: TextStyle(fontSize: size, letterSpacing: -.5)),
      ])),
      if (sub != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(sub!, style: TextStyle(fontSize: size * .55, fontWeight: FontWeight.w600, color: Theme.of(context).colorScheme.onSurfaceVariant))),
    ]);
  }
}
