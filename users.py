"""Manage Sheet Assistant accounts.

    python users.py add <username>      # prompts for the password (not shown, not saved in shell history)
    python users.py remove <username>
    python users.py list
"""
import getpass
import sys

import auth


def main(args: list[str]) -> int:
    if len(args) == 2 and args[0] == "add":
        password = getpass.getpass(f"Password for {args[1]}: ")
        if password != getpass.getpass("Repeat password: "):
            print("Passwords don't match.")
            return 1
        try:
            auth.add_user(args[1], password)
        except ValueError as e:
            print(e)
            return 1
        print(f"Saved {args[1].strip().lower()} in {auth.USERS_FILE}")
        return 0
    if len(args) == 2 and args[0] == "remove":
        print("Removed." if auth.remove_user(args[1]) else "No such user.")
        return 0
    if args == ["list"]:
        print("\n".join(auth.list_users()) or "(no users yet)")
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
