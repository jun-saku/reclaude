-- Names and avatars also refuse invisible characters that can make one name look like another: direction overrides
-- and marks, zero-width spaces, word joiners, the soft hyphen and the byte order mark. The zero-width joiner stays
-- (emoji such as 👨‍👩‍👧 need it).
alter table core.profiles drop constraint profiles_display_name_check;
alter table core.profiles drop constraint profiles_avatar_check;
alter table core.profiles add constraint profiles_display_name_check
  check (display_name = btrim(display_name) and char_length(display_name) between 1 and 24
    and display_name !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]');
alter table core.profiles add constraint profiles_avatar_check
  check (char_length(avatar) between 1 and 16
    and avatar !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]');

-- Functions in core are only for the database itself (triggers) unless a migration grants them: nobody can call
-- them through the API.
revoke execute on function core.touch_updated_at() from public;
alter default privileges in schema core revoke execute on functions from public;
