# A tracked folder named `utils`, `helpers`, `common`, `shared`, or `core` has no clear boundary.

Generic folder names hide what the code inside owns and collect unrelated modules over time.

Find the fix: inspect every file in the folder and group files by the domain concept they own. Move each group into a folder named for that subject, even when several domains import it. Move any file used by only one caller next to that caller. Remove the generic folder once every file is in a folder that describes all of its contents or beside its sole caller.

No fix: renaming the folder to any other label that would fit unrelated code, such as `misc` or `support`. Renaming the whole folder for its largest topic while leaving unrelated files inside it is also no fix.
