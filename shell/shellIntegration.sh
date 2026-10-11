# POSIX interactive shell integration (including dash).
if [ "${ISTERM_LOGIN:-}" = 1 ]; then
  if [ -r /etc/profile ]; then . /etc/profile; fi
  if [ -r "$HOME/.profile" ]; then . "$HOME/.profile"; fi
fi
if [ -n "${USER_SH_ENV:-}" ] && [ -r "$USER_SH_ENV" ] && [ "$USER_SH_ENV" != "$ENV" ]; then
  . "$USER_SH_ENV"
fi

__is_sh_cwd() {
  # Escape OSC delimiters before reporting the current directory.
  printf '%s' "$PWD" | sed 's/\\/\\\\/g; s/;/\\x3b/g'
}

__is_sh_prompt=${PS1:-'$ '}
if [ "${ISTERM_TESTING:-}" = 1 ]; then
  __is_sh_prompt='> '
fi
PS1="$(printf '\033]6973;PS\007')$__is_sh_prompt$(printf '\033]6973;PE\007')"'$(printf "\033]6973;CWD;%s\007" "$(__is_sh_cwd)")'
export PS1
