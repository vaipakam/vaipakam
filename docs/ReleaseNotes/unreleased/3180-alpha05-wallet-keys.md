## New app: what wallet you need, said before you connect

The platform does not create or hold wallets: you bring your own. The new app now says so before anything connects. The wallet picker, and Home while no wallet is connected, state that a self-custody wallet is needed, that the platform never holds its keys and cannot recover them, and that losing the keys means losing access to the funds. The statement links to a new page, also in the footer, that explains what a self-custody wallet is, what a recovery phrase is and how to keep it safe, and how to connect from a computer or a phone. It names no wallet brand.

This also fixes the connect button. On the live site, opening the wallet picker and closing it without finishing left the button reading "Connecting…" and impossible to press until the page was reloaded. The phone connection option prepares its link as soon as the picker opens, and that request stayed pending. The button now stays pressable and reads "Connecting…" only while an earlier session resumes.

The site's FAQ answer on wallets and the user guide say the same, and no longer list wallet brands. Closes #3671.
